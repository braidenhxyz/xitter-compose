// A bot that posts a fox every hour (this instance only, not upstream).
// It signs in with an API token from the bot account's Settings > API page and
// posts through the public API like any script: the photo to /api/v1/media,
// then the post to /api/v1/posts. Foxes come from randomfox.ca.
//
// In Docker (compose.yaml, profile foxbot):
//   FOX_BOT_TOKEN=xit_... in .env, then docker compose --profile foxbot up -d
// By hand:
//   FOX_BOT_TOKEN=xit_... XITTER_URL=https://your.instance bun scripts/fox-bot.ts [--once]
//
// FOX_BOT_EVERY_MINUTES (default 60) sets the pace; posts land on the hour
// (or the quarter, for 15) rather than wherever the bot happened to start.
//
// Fox on demand: a post that mentions the bot and says fox (or 🦊, floof) gets
// a fox in reply, checked every minute. One a person every 5 minutes, 30 an
// hour in all; FOX_BOT_REPLIES=0 turns it off.

const TOKEN = process.env.FOX_BOT_TOKEN ?? "";
const BASE = (process.env.XITTER_URL ?? "http://app:3000").replace(/\/$/, "");
const EVERY = Math.max(5, Number(process.env.FOX_BOT_EVERY_MINUTES ?? 60)) * 60_000;
const ONCE = process.argv.includes("--once");
const REPLIES = process.env.FOX_BOT_REPLIES !== "0";

if (!/^xit_[0-9a-f]{48}$/.test(TOKEN)) {
	console.error("fox bot: set FOX_BOT_TOKEN to a write token from the bot account's Settings > API page.");
	process.exit(1);
}

const CAPTIONS = [
	"hourly fox 🦊",
	"your fox for this hour 🦊",
	"fox o'clock 🦊",
	"a fox has arrived 🦊",
	"look at this fox 🦊",
	"fox. 🦊",
	"certified good fox 🦊",
	"another hour, another fox 🦊",
	"🦊🦊🦊",
	"this fox says hi 🦊",
];
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

// the last 100 foxes, so the same one doesn't come round again soon
const recent: string[] = [];

async function api(path: string, init: RequestInit = {}) {
	const r = await fetch(`${BASE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
	const body: any = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`${path}: ${r.status} ${body.error ?? ""}`.trim());
	return body.data;
}

async function fox(): Promise<{ image: Blob; type: string; link: string }> {
	for (let tries = 0; tries < 5; tries++) {
		const r = await fetch("https://randomfox.ca/floof/");
		if (!r.ok) throw new Error(`randomfox.ca: ${r.status}`);
		const { image, link } = (await r.json()) as { image: string; link: string };
		if (recent.includes(image) && tries < 4) continue;
		const file = await fetch(image);
		const type = (file.headers.get("content-type") ?? "image/jpeg").split(";")[0];
		if (!file.ok || !type.startsWith("image/")) throw new Error(`fox picture: ${file.status}`);
		recent.push(image);
		if (recent.length > 100) recent.shift();
		return { image: await file.blob(), type, link };
	}
	throw new Error("randomfox.ca kept sending the same foxes");
}

const REPLY_CAPTIONS = ["one fox, coming right up 🦊", "you asked, the fox delivers 🦊", "fox delivery 🦊", "here's your fox 🦊", "special order fox 🦊", "a fox, just for you 🦊"];

async function postFox(replyTo?: string) {
	const { image, type, link } = await fox();
	const media = await api("/media", { method: "POST", headers: { "content-type": type }, body: image });
	const post = await api("/posts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: `${pick(replyTo ? REPLY_CAPTIONS : CAPTIONS)}\n\n📷 ${link}`, media_ids: [media.media_id], ...(replyTo ? { reply_to: replyTo } : {}) }),
	});
	console.log(`${new Date().toISOString()} fox bot: ${replyTo ? `replied to ${replyTo} with` : "posted"} ${post?.id ?? "a fox"} (${link})`);
}

// ── fox on demand ─────────────────────────────────────────────────────────

const ASKS = /\bfox(es|y)?\b|🦊|\bfloofs?\b/i;
let newest = "0";
const lastBy = new Map<string, number>();
const sentAt: number[] = [];

async function answerMentions(me: { id: string; screen_name: string }) {
	const found: any[] = await api(`/search/posts?q=${encodeURIComponent(`@${me.screen_name}`)}&limit=20`);
	const fresh = found.filter((p) => BigInt(p.id) > BigInt(newest)).reverse();
	for (const p of fresh) newest = BigInt(p.id) > BigInt(newest) ? p.id : newest;
	for (const p of fresh) {
		if (p.author.id === me.id) continue;
		// "fox" in what they wrote, not just in the bot's name
		const said = String(p.text).replace(new RegExp(`@${me.screen_name}\\b`, "gi"), "");
		if (!ASKS.test(said)) continue;
		const now = Date.now();
		while (sentAt.length && now - sentAt[0] > 3_600_000) sentAt.shift();
		if (sentAt.length >= 30 || now - (lastBy.get(p.author.id) ?? 0) < 5 * 60_000) continue;
		lastBy.set(p.author.id, now);
		sentAt.push(now);
		await postFox(p.id).catch((e) => console.error(`${new Date().toISOString()} fox bot: reply to ${p.id} failed: ${e.message}`));
	}
}

async function once() {
	// a failed hour waits for the next one rather than spamming retries
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			return await postFox();
		} catch (e) {
			console.error(`${new Date().toISOString()} fox bot: try ${attempt} failed: ${(e as Error).message}`);
			if (attempt < 3) await Bun.sleep(30_000 * attempt);
		}
	}
}

const me = await api("/me").catch((e) => {
	console.error(`fox bot: can't sign in at ${BASE}: ${e.message}`);
	process.exit(1);
});
console.log(`fox bot: posting as @${me.screen_name} to ${BASE}, every ${EVERY / 60_000} minutes${REPLIES ? ", and answering fox requests" : ""}`);

if (ONCE) {
	await once();
	process.exit(0);
}
if (REPLIES) {
	// what's there already isn't asked again: only mentions from now on
	const start: any[] = await api(`/search/posts?q=${encodeURIComponent(`@${me.screen_name}`)}&limit=1`).catch(() => []);
	newest = start[0]?.id ?? "0";
	setInterval(() => answerMentions(me).catch((e) => console.error(`${new Date().toISOString()} fox bot: mentions: ${e.message}`)), 60_000);
}
for (;;) {
	// the next whole interval: on the hour for 60, on the quarter for 15
	const wait = EVERY - (Date.now() % EVERY);
	await Bun.sleep(wait);
	await once();
}
