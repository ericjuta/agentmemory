import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startViewerServer } from "../src/viewer/server.js";

const servers: Server[] = [];

afterEach(async () => {
  delete process.env["VIEWER_HOST"];
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
});

async function startServer(host?: string): Promise<Server> {
  if (host) process.env["VIEWER_HOST"] = host;
  else delete process.env["VIEWER_HOST"];
  const server = startViewerServer(0, null, null);
  servers.push(server);
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  return server;
}

function addressInfo(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("viewer server did not expose a TCP address");
  }
  return address;
}

describe("viewer server listen host", () => {
  it("defaults to loopback for local runs", async () => {
    const server = await startServer();
    const address = addressInfo(server);

    expect(address.address).toBe("127.0.0.1");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agentmemory/livez`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "agentmemory",
      status: "ok",
    });
  });

  it("allows Docker to force an IPv4 wildcard bind", async () => {
    const server = await startServer("0.0.0.0");
    const address = addressInfo(server);

    expect(address.address).toBe("0.0.0.0");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agentmemory/livez`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "agentmemory",
      status: "ok",
    });
  });
});
