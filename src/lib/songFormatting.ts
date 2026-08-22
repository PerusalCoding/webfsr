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

// Maps StepMania's raw Grade enum (via ToEnumShortString(stats:GetGrade()),
// e.g. "Tier02") onto the actual stock ITG/Simply Love grade ladder. This
// replaces an earlier score-threshold approximation -- the exact tier list
// turned out to be exactly the 17 tiers StepMania's Grade enum already
// exposes, so there's no need to approximate from the score percentage
// anymore; the game already told us the real grade.
//
// Source: ITG Wiki's "stock" grade thresholds (itgwiki.dominick.cc), which
// map 1:1 onto Grade_Tier01..Grade_Tier17 in tier order.
interface GradeTierInfo {
	label: string;
	// Tailwind classes for the badge -- roughly banded by "how good": the
	// star tiers (quad/tristar/double/single) get gold, S-tiers get
	// yellow, A-tiers green, B-tiers blue, C-tiers purple, D gray. Not an
	// official ITG color scheme, just a readable visual ladder.
	className: string;
}

const GRADE_TIERS: Record<string, GradeTierInfo> = {
	Tier01: { label: "★★★★", className: "bg-amber-500 text-black" }, // Quad, 100.00%
	Tier02: { label: "★★★", className: "bg-amber-500 text-black" },  // Tristar, 99.00%
	Tier03: { label: "★★", className: "bg-amber-500/90 text-black" }, // 98.00%
	Tier04: { label: "★", className: "bg-amber-500/80 text-black" },  // 96.00%
	Tier05: { label: "S+", className: "bg-yellow-400 text-black" },   // 94.00%
	Tier06: { label: "S", className: "bg-yellow-400/90 text-black" }, // 92.00%
	Tier07: { label: "S-", className: "bg-yellow-400/80 text-black" }, // 89.00%
	Tier08: { label: "A+", className: "bg-emerald-500 text-white" },  // 86.00%
	Tier09: { label: "A", className: "bg-emerald-500/90 text-white" }, // 83.00%
	Tier10: { label: "A-", className: "bg-emerald-500/80 text-white" }, // 80.00%
	Tier11: { label: "B+", className: "bg-sky-500 text-white" },      // 76.00%
	Tier12: { label: "B", className: "bg-sky-500/90 text-white" },    // 72.00%
	Tier13: { label: "B-", className: "bg-sky-500/80 text-white" },   // 68.00%
	Tier14: { label: "C+", className: "bg-purple-500 text-white" },   // 64.00%
	Tier15: { label: "C", className: "bg-purple-500/90 text-white" }, // 60.00%
	Tier16: { label: "C-", className: "bg-purple-500/80 text-white" }, // 55.00%
	Tier17: { label: "D", className: "bg-gray-500 text-white" },      // below 55.00%
};

// Score-threshold fallback -- only used for log entries with no usable
// `grade` field (older entries logged before SongHRLog.lua captured it,
// or an unrecognized/future enum value). Thresholds mirror the same
// stock ITG table above so the fallback stays consistent with the real
// tiers whenever it has to guess from score percentage instead.
function gradeInfoFromScore(score: string): GradeTierInfo {
	const pct = parseFloat(score);
	if (Number.isNaN(pct)) return { label: "—", className: "bg-gray-600 text-white" };
	if (pct >= 100) return GRADE_TIERS.Tier01;
	if (pct >= 99) return GRADE_TIERS.Tier02;
	if (pct >= 98) return GRADE_TIERS.Tier03;
	if (pct >= 96) return GRADE_TIERS.Tier04;
	if (pct >= 94) return GRADE_TIERS.Tier05;
	if (pct >= 92) return GRADE_TIERS.Tier06;
	if (pct >= 89) return GRADE_TIERS.Tier07;
	if (pct >= 86) return GRADE_TIERS.Tier08;
	if (pct >= 83) return GRADE_TIERS.Tier09;
	if (pct >= 80) return GRADE_TIERS.Tier10;
	if (pct >= 76) return GRADE_TIERS.Tier11;
	if (pct >= 72) return GRADE_TIERS.Tier12;
	if (pct >= 68) return GRADE_TIERS.Tier13;
	if (pct >= 64) return GRADE_TIERS.Tier14;
	if (pct >= 60) return GRADE_TIERS.Tier15;
	if (pct >= 55) return GRADE_TIERS.Tier16;
	return GRADE_TIERS.Tier17;
}

export interface GradeDisplay {
	label: string;
	className: string;
}

// `grade` is the raw ToEnumShortString(stats:GetGrade()) value logged by
// SongHRLog.lua (e.g. "Tier02"). `passed`/`score` are only used as a
// fallback for older log entries logged before the grade field existed.
export function gradeDisplay(grade: string | undefined, passed: boolean, score: string): GradeDisplay {
	if (!passed) return { label: "F", className: "bg-red-600 text-white" };
	if (grade && GRADE_TIERS[grade]) return GRADE_TIERS[grade];
	if (grade === "NoData" || grade === "Failed") return { label: "—", className: "bg-gray-600 text-white" };
	return gradeInfoFromScore(score);
}

export function difficultyBadge(style: string, difficultyName: string, meter: number): string {
	const styleLetter = style.toLowerCase().startsWith("double") ? "D" : "S";
	const diffLetter = DIFFICULTY_LETTER[difficultyName] ?? difficultyName.charAt(0).toUpperCase() ?? "?";
	return `${styleLetter}${diffLetter} ${meter}`;
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

// Judgment labels in stock ITG naming/order (matches the classic
// Fantastic/Excellent/Great/Decent/WayOff/Miss point-value table), used
// for the "enlarge to show stats" per-song judgment breakdown. Order
// here is display order, best to worst.
export const JUDGMENT_LABELS: { key: "fantastic" | "excellent" | "great" | "decent" | "wayOff" | "miss"; label: string; className: string }[] = [
	{ key: "fantastic", label: "Fantastic", className: "text-cyan-400" },
	{ key: "excellent", label: "Excellent", className: "text-yellow-400" },
	{ key: "great", label: "Great", className: "text-green-400" },
	{ key: "decent", label: "Decent", className: "text-orange-400" },
	{ key: "wayOff", label: "Way Off", className: "text-red-500" },
	{ key: "miss", label: "Miss", className: "text-red-700" },
];

// Formats a rate mod for display, e.g. 1.2 -> "1.2x". Omits entirely
// (returns null) for a normal, unmodified 1.0x rate so the badge only
// shows up when it's actually meaningful -- most plays aren't rate-modded,
// and showing "1.0x" on every single row would just be visual noise.
export function formatRate(rate: number | undefined): string | null {
	if (rate == null || Math.abs(rate - 1) < 0.001) return null;
	// Trim trailing zeros (1.20 -> 1.2) but keep at least one decimal.
	return `${rate.toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0")}x`;
}

