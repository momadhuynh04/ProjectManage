const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const args = process.argv.slice(2);
const port = parseInt(args[0]) || 9876;
const command = args[1] || 'cmd.exe';
const cwd = args[2] || process.cwd();
const cols = parseInt(args[3]) || 80;
const rows = parseInt(args[4]) || 24;

const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    FORCE_COLOR: '1',
    NODE_NO_WARNINGS: '1'
});

const wss = new WebSocketServer({ port: port });

let ptyFile = command;
let ptyArgs = [];

if (process.platform === 'win32') {
    const firstSpace = command.indexOf(' ');
    if (firstSpace > 0) {
        ptyFile = command.substring(0, firstSpace);
        const rest = command.substring(firstSpace + 1);
        if (ptyFile.toLowerCase().endsWith('cmd.exe') || ptyFile.toLowerCase() === 'cmd') {
            ptyArgs = ['/c', rest.replace(/^\/c\s*/i, '')];
        } else {
            ptyArgs = rest.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        }
    }
}

wss.on('connection', (ws) => {
    const ptyProcess = pty.spawn(ptyFile, ptyArgs, {
        name: 'xterm-256color',
        cols: cols,
        rows: rows,
        cwd: cwd,
        env: env
    });

    ptyProcess.onData((data) => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'output', data: data }));
        }
    });

    ptyProcess.onExit(({ exitCode }) => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
            ws.close();
        }
    });

    ws.on('message', (msg) => {
        try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'input') {
                ptyProcess.write(parsed.data);
            } else if (parsed.type === 'resize') {
                ptyProcess.resize(parsed.cols, parsed.rows);
            } else if (parsed.type === 'kill') {
                ptyProcess.kill();
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        try { ptyProcess.kill(); } catch (e) {}
    });

    ws.send(JSON.stringify({ type: 'ready' }));
});

process.on('SIGINT', () => {
    wss.close();
    process.exit(0);
});
