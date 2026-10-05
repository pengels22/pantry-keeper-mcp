import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const INVENTORY_URL =
  "https://pengels22.github.io/Pantry_Keeper/inventory.json";

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function item(r: Row) {
  const usable = num(r["inventory.usable_quantity"]);
  const reserved = num(r["inventory.reserved_quantity"]) ?? 0;
  return {
    inventory_id: num(r["inventory.id"]),
    product_id: num(r["inventory.product_id"]),
    name: str(r["product.name"]) ?? "Unnamed item",
    brand: str(r["product.brand"]),
    size: str(r["product.size"]),
    unit: str(r["product.unit"]),
    category: str(r["product.category"]),
    location:
      str(r["inventory.location"]) ?? str(r["product.default_location"]),
    quantity: num(r["inventory.quantity"]),
    usable_quantity: usable,
    usable_unit: str(r["inventory.usable_unit"]),
    reserved_quantity: reserved,
    available_quantity:
      usable === null ? null : Math.max(0, usable - reserved),
    notes: str(r["product.notes"]),
    upc: str(r["product.gtin_normalized"]) ?? str(r["product.upc"]),
    last_updated: str(r["inventory.last_updated"]),
  };
}

async function loadInventory() {
  const response = await fetch(INVENTORY_URL, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!response.ok) {
    throw new Error(`Inventory source returned HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Inventory source is not an array");
  return data
    .filter((x): x is Row => !!x && typeof x === "object")
    .map(item);
}

function filtered(
  rows: ReturnType<typeof item>[],
  location?: string,
  category?: string,
  availableOnly = false,
) {
  return rows.filter((x) => {
    if (
      location &&
      (x.location ?? "").toLowerCase() !== location.toLowerCase()
    )
      return false;
    if (
      category &&
      (x.category ?? "").toLowerCase() !== category.toLowerCase()
    )
      return false;
    if (
      availableOnly &&
      !(x.available_quantity !== null && x.available_quantity > 0)
    )
      return false;
    return true;
  });
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function createServer() {
  const server = new McpServer({
    name: "pantry-keeper-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_inventory",
    {
      description:
        "Read Pantry Keeper inventory. Read-only. Use available_only=true for recipe-ready stock.",
      inputSchema: {
        location: z.string().optional(),
        category: z.string().optional(),
        available_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ location, category, available_only, limit }) => {
      const rows = filtered(
        await loadInventory(),
        location,
        category,
        available_only,
      )
        .slice(0, limit)
        .map((x) => x);
      return result({
        source: INVENTORY_URL,
        read_only: true,
        count: rows.length,
        items: rows,
      });
    },
  );

  server.registerTool(
    "search_inventory",
    {
      description:
        "Search Pantry Keeper inventory by product name, brand, category, size, notes, location, or UPC. Read-only.",
      inputSchema: {
        query: z.string().min(1),
        location: z.string().optional(),
        category: z.string().optional(),
        available_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(100).optional().default(50),
      },
    },
    async ({ query, location, category, available_only, limit }) => {
      const q = query.toLowerCase().trim();
      const rows = filtered(
        await loadInventory(),
        location,
        category,
        available_only,
      )
        .filter((x) =>
          [
            x.name,
            x.brand,
            x.size,
            x.unit,
            x.category,
            x.location,
            x.notes,
            x.upc,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
        .slice(0, limit);
      return result({ query, count: rows.length, items: rows });
    },
  );

  server.registerTool(
    "get_available_ingredients",
    {
      description:
        "Return recipe-ready Pantry Keeper ingredients. Only items with configured usable quantity greater than reserved quantity are included. Read-only.",
      inputSchema: {
        location: z.string().optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(200),
      },
    },
    async ({ location, category, limit }) => {
      const rows = filtered(
        await loadInventory(),
        location,
        category,
        true,
      )
        .slice(0, limit)
        .map((x) => ({
          inventory_id: x.inventory_id,
          name: x.name,
          brand: x.brand,
          size: x.size,
          category: x.category,
          location: x.location,
          available_quantity: x.available_quantity,
          unit: x.usable_unit,
          notes: x.notes,
        }));
      return result({
        source: INVENTORY_URL,
        read_only: true,
        recipe_ready_count: rows.length,
        items: rows,
      });
    },
  );

  server.registerTool(
    "get_inventory_categories",
    {
      description: "List categories currently present in Pantry Keeper. Read-only.",
      inputSchema: {},
    },
    async () => {
      const categories = [
        ...new Set(
          (await loadInventory())
            .map((x) => x.category)
            .filter((x): x is string => Boolean(x)),
        ),
      ].sort((a, b) => a.localeCompare(b));
      return result({ count: categories.length, categories });
    },
  );

  return server;
}

const mcp = createMcpHandler(createServer, {
  route: "/mcp",
  legacy: "reject",
});

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(
        "Pantry Keeper MCP is running. MCP endpoint: /mcp\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return mcp(request, env, ctx);
  },
} satisfies ExportedHandler;
