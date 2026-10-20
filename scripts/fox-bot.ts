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

const TOKEN = process.env.FOX_BOT_TOKEN ?? "";
const BASE = (process.env.XITTER_URL ?? "http://app:3000").replace(/\/$/, "");
const EVERY = Math.max(5, Number(process.env.FOX_BOT_EVERY_MINUTES ?? 60)) * 60_000;
const ONCE = process.argv.includes("--once");

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

async function postFox() {
	const { image, type, link } = await fox();
	const media = await api("/media", { method: "POST", headers: { "content-type": type }, body: image });
	const post = await api("/posts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: `${pick(CAPTIONS)}\n\n📷 ${link}`, media_ids: [media.media_id] }),
	});
	console.log(`${new Date().toISOString()} fox bot: posted ${post?.id ?? "a fox"} (${link})`);
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
console.log(`fox bot: posting as @${me.screen_name} to ${BASE}, every ${EVERY / 60_000} minutes`);

if (ONCE) {
	await once();
	process.exit(0);
}
for (;;) {
	// the next whole interval: on the hour for 60, on the quarter for 15
	const wait = EVERY - (Date.now() % EVERY);
	await Bun.sleep(wait);
	await once();
}
