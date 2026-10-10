// A resolver that asks for STARTTLS must get it: when the server does not
// offer STARTTLS (or an on-path attacker strips it), the connection fails
// instead of authenticating in clear text.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { setTenantSmtpResolver, testConnection } from "../services/email.service";

// Plain SMTP server that never offers STARTTLS and records AUTH attempts.
const authAttempts: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((sock) => {
    let buf = "";
    let awaitingCredentials = false;
    sock.write("220 plain.example ESMTP\r\n");
    sock.on("data", (data) => {
      buf += data.toString("latin1");
      let end = buf.indexOf("\r\n");
      while (end >= 0) {
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        if (awaitingCredentials) {
          authAttempts.push(line);
          awaitingCredentials = false;
          sock.write("235 2.7.0 Authentication successful\r\n");
        } else if (/^EHLO /i.test(line)) {
          sock.write("250-plain.example\r\n250 AUTH PLAIN\r\n");
        } else if (/^AUTH PLAIN$/i.test(line)) {
          awaitingCredentials = true;
          sock.write("334 \r\n");
        } else if (/^AUTH PLAIN /i.test(line)) {
          authAttempts.push(line.slice("AUTH PLAIN ".length));
          sock.write("235 2.7.0 Authentication successful\r\n");
        } else if (/^STARTTLS/i.test(line)) {
          sock.write("502 5.5.1 STARTTLS not supported\r\n");
        } else if (/^QUIT/i.test(line)) {
          sock.end("221 bye\r\n");
        } else {
          sock.write("250 OK\r\n");
        }
        end = buf.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  setTenantSmtpResolver(null);
  authAttempts.length = 0;
});

function useServer(requireTLS: boolean): void {
  setTenantSmtpResolver(async () => ({
    host: "127.0.0.1",
    port,
    secure: false,
    user: "billing@example.com",
    pass: "smtp-password-in-the-clear",
    fromAddress: "billing@example.com",
    requireTLS,
  }));
}

describe("SMTP STARTTLS requirement", () => {
  test("a resolver that requires STARTTLS never authenticates in clear text", async () => {
    useServer(true);
    const result = await testConnection();
    expect(result.success).toBe(false);
    expect(authAttempts).toEqual([]);
  });

  test("without the requirement the same server gets the credentials", async () => {
    useServer(false);
    const result = await testConnection();
    expect(result.success).toBe(true);
    expect(authAttempts.length).toBe(1);
  });
});
