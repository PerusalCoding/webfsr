// Maps a raw difficulty enum string (from steps:GetDifficulty() via
// ToEnumShortString) onto the single-letter convention used across ITG --
// B/E/M/H/X for Beginner/Easy/Medium/Hard/Challenge. If your theme uses
// different labels, adjust this map.
const DIFFICULTY_LETTER: Record<string, string> = {
	Beginner: "B",
	Easy: "E",
	Medium: "M",
	Hard: "H",
	Challenge: "X",
	Edit: "Ed",
};

export function difficultyBadge(style: string, difficultyName: string, meter: number): string {
	const styleLetter = style.toLowerCase().startsWith("double") ? "D" : "S";
	const diffLetter = DIFFICULTY_LETTER[difficultyName] ?? difficultyName.charAt(0).toUpperCase() ?? "?";
	return `${styleLetter}${diffLetter} ${meter}`;
}

// There's no reliable way to decode StepMania's grade enum into letter
// grades without knowing your exact tier list, so stars here are derived
// from score thresholds instead -- an approximation, not a literal replay
// of the in-game grade. Adjust the cutoffs if they don't feel right.
export function starsForScore(score: string): number {
	const pct = parseFloat(score);
	if (Number.isNaN(pct)) return 0;
	if (pct >= 93) return 3;
	if (pct >= 88) return 2;
	if (pct >= 80) return 1;
	return 0;
}

export function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(epochSeconds: number): { date: string; time: string } {
	const d = new Date(epochSeconds * 1000);
	return {
		date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
		time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
	};
}

export function dayKey(epochSeconds: number): string {
	const d = new Date(epochSeconds * 1000);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(epochSeconds: number): string {
	const d = new Date(epochSeconds * 1000);
	const today = new Date();
	const yesterday = new Date();
	yesterday.setDate(today.getDate() - 1);

	if (dayKey(epochSeconds) === dayKey(today.getTime() / 1000)) return "Today";
	if (dayKey(epochSeconds) === dayKey(yesterday.getTime() / 1000)) return "Yesterday";
	return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}
