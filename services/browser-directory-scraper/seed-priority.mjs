import { VERTICALS, buildQueries, taskKey } from "./app.mjs";
import { close, seedTasks } from "./db.mjs";

const zip = String(process.env.PRIORITY_ZIP || "98033").padStart(5, "0");
const city = process.env.PRIORITY_CITY || "Kirkland";
const state = (process.env.PRIORITY_STATE || "WA").toUpperCase();
const selected = String(process.env.PRIORITY_VERTICALS || VERTICALS.join(","))
  .split(",").map((value) => value.trim()).filter((value) => VERTICALS.includes(value));
const tasks = [];
for (const vertical of selected) {
  for (const query of buildQueries(vertical, zip, city, state)) {
    tasks.push({ taskId: taskKey({ vertical, zip, query }), vertical, zip, city, state, query });
  }
}
try {
  await seedTasks(tasks);
  console.log(JSON.stringify({ event: "tasks.seeded", zip, city, state, count: tasks.length, verticals: selected }));
} finally {
  await close();
}
