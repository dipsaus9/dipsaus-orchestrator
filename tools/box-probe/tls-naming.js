// The escape probe's TLS line (DIPO-343): a tunnel to example.com through the proxy in
// HTTPS_PROXY, whose TLS handshake then names registry.npmjs.org. Prints what happened; the web
// proxy must close the tunnel before the registry answers.
const net = require("net");
const tls = require("tls");
const u = new URL(process.env.HTTPS_PROXY);
function closed() {
  console.log("TLS naming another host -> closed");
  process.exit(0);
}

const s = net.connect(Number(u.port), u.hostname, () =>
  s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"),
);
s.once("data", (d) => {
  if (!String(d).startsWith("HTTP/1.1 200")) {
    console.log(`TLS naming another host -> tunnel refused: ${String(d).split("\r\n")[0]}`);
    process.exit(0);
  }
  const t = tls.connect(
    { socket: s, servername: "registry.npmjs.org", rejectUnauthorized: false },
    () => t.write("GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n"),
  );
  t.on("data", () => {
    console.log("TLS naming another host -> ANSWERED");
    process.exit(1);
  });
  t.on("error", closed);
  t.on("close", closed);
});
s.on("error", () => {
  console.log("TLS naming another host -> no proxy");
  process.exit(1);
});
// oxlint-disable-next-line no-restricted-globals -- probe code that runs in a box, with no dipo clock
setTimeout(() => {
  console.log("TLS naming another host -> timed out");
  process.exit(1);
}, 15000);
