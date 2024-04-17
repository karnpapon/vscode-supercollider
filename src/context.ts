import * as cp from 'child_process';
import * as dgram from 'dgram';
import * as vscode from 'vscode';
import {Disposable,
        workspace} from 'vscode';
import {ExecuteCommandRequest,
        LanguageClient,
        LanguageClientOptions,
        MessageTransports,
        ServerOptions} from 'vscode-languageclient/node';

import {EvaluateSelectionFeature} from './commands/evaluate';
import * as defaults from './util/defaults';
import { getSclangPath } from './util/sclang';
import {UDPMessageReader,
        UDPMessageWriter} from './util/readerWriter';

const lspAddress = '127.0.0.1';

export class SuperColliderContext implements Disposable
{
    subscriptions: vscode.Disposable[] = [];
    client!: LanguageClient;
    evaluateSelectionFeature!: EvaluateSelectionFeature;
    sclangProcess: cp.ChildProcess;
    lspTokenPath: string;
    outputChannel: vscode.OutputChannel;
    readerSocket: dgram.Socket;
    activated: boolean = false;

        const configuration = workspace.getConfiguration()

        const sclangPath = await getSclangPath()
        let sclangConfYaml = configuration.get<string>('supercollider.sclang.confYaml', defaults.userConfigPath())
        const loadWorkspaceYaml = configuration.get<boolean>('supercollider.sclang.loadWorkspaceConfYaml', false)
        const sclangArgs = configuration.get<Array<string>>('supercollider.sclang.args')
        const sclangEnv = configuration.get<Object>('supercollider.sclang.environment')

        if (loadWorkspaceYaml) {
            let confFiles = []

            const folders = workspace.workspaceFolders || [];
            for (let folder of folders) {
                let found = await workspace.findFiles(new vscode.RelativePattern(folder, "sclang_conf.yaml"));
                confFiles.push(...found);
            }

            if (confFiles.length == 1) {
                sclangConfYaml = confFiles[0].fsPath;
            } else if (confFiles.length > 1) {
                vscode.window.showErrorMessage("Multiple sclang_conf.yaml files found in workspace. Please set supercollider.sclang.confYaml to the desired file.")
            } else {
                // No files, so use the default
            }
        }

        let env = process.env;

        let spawnOptions: cp.SpawnOptions = {
            env : Object.assign(env, sclangEnv)
            // cwd?: string;
            // stdio?: any;
            // detached?: boolean;
            // uid?: number;
            // gid?: number;
            // shell?: boolean | string;
        }

        let args = sclangArgs || [];

        return {
            command: sclangPath,
            args: [
                ...args,
                ...['-i', 'vscode',
                    '-l', sclangConfYaml]
                ],
            options: spawnOptions
        };
    }

    disposeProcess()
    {
        if (this.sclangProcess)
        {
            this.sclangProcess.kill();
            this.sclangProcess = null;
        }
    }

    async createProcess(readPort: number, writePort: number)
    {
        if (this.sclangProcess)
        {
            this.sclangProcess.kill()
        }

        let options       = await this.processOptions(readPort, writePort);
        let sclangProcess = cp.spawn(options.command, options.args, options.options);

        if (!sclangProcess || !sclangProcess.pid)
        {
            return null;
        }

        return sclangProcess;
    }

    async cleanup()
    {
        this.activated = false;

        if (this.client?.isRunning())
        {
            await this.client.stop();
        }
            
        this.disposeProcess();
        // this.evaluateSelectionFeature.dispose();
        this.subscriptions.forEach((d) => {
            d.dispose();
        });
        this.subscriptions = [];
    };

    dispose() {
        return this.cleanup()
    }

    async activate(globalStoragePath: string, outputChannel: vscode.OutputChannel, workspaceState: vscode.Memento)
    {
        let that           = this;
        this.cleanup();

        this.outputChannel = outputChannel;
        outputChannel.show();

        const serverOptions: ServerOptions = function() {
            // @TODO what if terminal launch fails?

            const configuration = workspace.getConfiguration()

            return new Promise<MessageTransports>((res, err) => {
                let readerSocket = new Promise<dgram.Socket>((resolve, reject) => {
                    let socket = dgram.createSocket('udp4');
                    socket.bind(0, lspAddress, () => {
                        resolve(socket);
                    })
                });
                let writerSocket = new Promise<dgram.Socket>((resolve, reject) => {
                                       let socket = dgram.createSocket('udp4');
                                       socket.bind({
                                           address : lspAddress,
                                           exclusive : false
                                       },
                                                   () => {
                                                       resolve(socket);
                                                   })
                                   }).then((socket) => {
                    // SUBTLE: SuperCollider cannot open port=0 (e.g. OS assigneded) ports. So, we stand a better chance of
                    //         finding an open port by opening on our end, then immediately closing and pointing SC that one.
                    var port = socket.address().port;
                    return new Promise<number>((resolve, reject) => {
                                                   socket.close(() => {
                                                       resolve(port);
                                                   })})
                });

                Promise.all([ readerSocket, writerSocket ]).then(async (sockets) => {
                    let socket        = sockets[0];
                    that.readerSocket = socket;

                    let readerPort    = socket.address().port;
                    let writerPort    = sockets[1];
                    let reader        = new UDPMessageReader(socket);
                    let writer        = new UDPMessageWriter(socket, writerPort, lspAddress)

                    let sclangProcess = that.sclangProcess = await that.createProcess(readerPort, writerPort);

                    if (!sclangProcess)
                    {
                        err("Problem launching sclang executable. Check your settings to ensure `supercollider.sclang.cmd` points to a valid sclang path.")
                    }

                    const streamInfo: MessageTransports = {reader : reader, writer : writer, detached : false};

                    sclangProcess.stdout
                        .on('data', data => {
                            let string = data.toString();
                            if (string.indexOf('***LSP READY***') != -1)
                            {
                                res(streamInfo);
                            }
                            outputChannel.append(string);
                        })
                        .on('end', () => {
                            // outputChannel.append("sclang exited");
                            reader.dispose();
                            writer.dispose()
                        })
                        .on('error', (err) => {
                            // outputChannel.append("sclang errored: " + err);
                            reader.dispose();
                            writer.dispose()
                        });

                    sclangProcess.on('exit', (code, signal) => {
                        sclangProcess = null;
                        reader.dispose();
                        writer.dispose()
                    });
                });
            });
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector : [ {scheme : 'file', language : 'supercollider'} ],
            synchronize : {
                fileEvents : workspace.createFileSystemWatcher('**/*.*'),
            },
            outputChannel : outputChannel,
            markdown : {
                supportHtml : true,
                isTrusted : true
            }
        };

        let client                     = new LanguageClient('SuperColliderLanguageServer', 'SuperCollider Language Server', serverOptions, clientOptions, true);
        // client.trace                   = Trace.Verbose;

        const evaluateSelectionFeature = new EvaluateSelectionFeature(client, this);
        var [disposable, provider]     = evaluateSelectionFeature.registerLanguageProvider();
        this.subscriptions.push(disposable);

        client.registerFeature(evaluateSelectionFeature);

        this.client                   = client;
        this.evaluateSelectionFeature = evaluateSelectionFeature;

        await this.client.start();
        this.activated = true;
    }

    executeCommand(command: string)
    {
        let result = this.client.sendRequest(ExecuteCommandRequest.type, {command});
        result.then(function(result) {
            console.log(result)
        });
    }
}