// Manual live check: can Marlo's server call these public travel MCP servers with no per-user
// sign-in? Connects anonymously, prints each server's tools with their input schemas, then (if
// given) calls one tool and prints the raw result. Not part of the test suite (hits real servers).
//   npm run travel:probe                                   — list tools on every server
//   npm run travel:probe -- lastminute search_flights '{"origin":"LHR",...}'  — call one tool
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVERS: Record<string, string> = {
  lastminute: "https://mcp.lastminute.com/mcp",
  slicktrip: "https://mcp.slicktrip.com/mcp",
  kiwi: "https://mcp.kiwi.com",
};

async function connect(name: string, url: string): Promise<Client> {
  const client = new Client({ name: `marlowe-travel-probe-${name}`, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 15_000 });
  return client;
}

function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: string };
  return `${e?.code !== undefined ? `[${String(e.code)}] ` : ""}${e?.message ?? String(err)}`;
}

const [serverArg, toolArg, argsJson] = process.argv.slice(2);

if (toolArg) {
  const url = SERVERS[serverArg];
  if (!url) {
    console.error(`Unknown server "${serverArg}". Known: ${Object.keys(SERVERS).join(", ")}`);
    process.exit(1);
  }
  const client = await connect(serverArg, url);
  try {
    const result = await client.callTool({ name: toolArg, arguments: argsJson ? JSON.parse(argsJson) : {} }, undefined, {
      timeout: 60_000,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`call failed: ${describeError(err)}`);
  }
  await client.close();
  process.exit(0);
}

for (const [name, url] of Object.entries(SERVERS)) {
  console.log(`\n=== ${name} (${url}) ===`);
  let client: Client;
  try {
    client = await connect(name, url);
  } catch (err) {
    console.log(`connect failed: ${describeError(err)}`);
    continue;
  }
  try {
    const { tools } = await client.listTools(undefined, { timeout: 15_000 });
    console.log(`connected anonymously; ${tools.length} tools`);
    for (const t of tools) {
      console.log(`\n- ${t.name}: ${(t.description ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
      console.log(`  input: ${JSON.stringify(t.inputSchema)}`);
    }
  } catch (err) {
    console.log(`listTools failed: ${describeError(err)}`);
  }
  await client.close().catch(() => {});
}
process.exit(0);
