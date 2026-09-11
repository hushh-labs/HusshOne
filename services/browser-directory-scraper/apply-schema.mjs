import { applySchema, close } from "./db.mjs";

try {
  await applySchema();
  console.log(JSON.stringify({ event: "schema.applied", database: process.env.PGDATABASE || "hotel_scraper" }));
} finally {
  await close();
}
