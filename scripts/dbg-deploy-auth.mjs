import { chromium } from "playwright";
const BASE = "https://claude-chess-nine.vercel.app";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" },
  args: ["--ssl-version-max=tls1.2"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("console:", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
await page.goto(BASE, { waitUntil: "networkidle" }).catch((e) => console.log("goto:", e.message));
await page.waitForTimeout(6000);
const env = await page.evaluate(() => ({
  hasSupabaseEnv: !!(window).__NEXT_DATA__ ? "next-data" : "app-router",
}));
const me = await page.evaluate(async () => {
  const r = await fetch("/api/account/me");
  return { status: r.status, text: (await r.text()).slice(0, 300) };
});
const cookies = (await ctx.cookies()).map((c) => c.name);
console.log("me:", JSON.stringify(me));
console.log("cookies:", cookies.join(", ") || "(none)");
console.log("env:", JSON.stringify(env));
const chip = await page.evaluate(() => document.body.innerText.slice(0, 400));
console.log("page text:", chip.replace(/\n+/g, " | ").slice(0, 300));
await browser.close();
