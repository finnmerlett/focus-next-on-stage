// Test only. Listens on 127.0.0.1:$FLN_BRIDGE_PORT and runs the posted function body in the
// extension host, with `vscode` and `git` (the git extension API) in scope.
const http = require('node:http');
const vscode = require('vscode');

let server;

exports.activate = async () => {
  const port = Number(process.env.FLN_BRIDGE_PORT);
  if (!port) return;
  const gitExt = vscode.extensions.getExtension('vscode.git');
  const git = (await gitExt.activate()).getAPI(1);
  const AsyncFunction = (async () => {}).constructor;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const fn = new AsyncFunction('vscode', 'git', body);
        const value = await fn(vscode, git);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: value === undefined ? null : value }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.stack || err) }));
      }
    });
  });
  server.listen(port, '127.0.0.1');
};

exports.deactivate = () => server && server.close();
