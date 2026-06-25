// Cinematic-theme engine for video narration. The narrator LLM gets a handful
// of randomly drawn themes to mix and match — overlaying a recorded QA session
// with absurd genre commentary (a checkout flow narrated as a submarine
// disaster film, a login as a noir radio drama) keeps long review videos
// watchable. Themes are deliberately hand-written and specific: a procedural
// "{decade} {genre}" template produces bland, repetitive filler, whereas a
// curated list gives the model concrete, evocative material to riff on.

/** Broad genre buckets so a caller can bias toward a register if it ever wants. */
export type ThemeCategory =
  | "movie"
  | "tv"
  | "documentary"
  | "commercial"
  | "training"
  | "radio"
  | "sports"
  | "game_show"
  | "soap"
  | "news"
  | "kids";

export interface Theme {
  category: ThemeCategory;
  /** Human-readable prompt fragment, e.g. "1970s heist thriller". */
  label: string;
}

/**
 * The curated theme catalog. Grouped by category for readability; order is not
 * significant since draws are randomized. Every label is unique (asserted in
 * tests) — keep it that way when adding entries.
 */
export const THEMES: Theme[] = [
  // --- movie ---
  { label: "1970s heist thriller", category: "movie" },
  { label: "submarine disaster film", category: "movie" },
  { label: "epic space opera", category: "movie" },
  { label: "gritty neo-noir detective film", category: "movie" },
  { label: "silent black-and-white slapstick comedy", category: "movie" },
  { label: "overwrought disaster blockbuster", category: "movie" },
  { label: "spaghetti western showdown", category: "movie" },
  { label: "found-footage horror movie", category: "movie" },
  { label: "swords-and-sandals historical epic", category: "movie" },
  { label: "80s buddy-cop action movie", category: "movie" },
  { label: "French New Wave art film", category: "movie" },
  { label: "courtroom legal drama", category: "movie" },
  { label: "kaiju monster rampage film", category: "movie" },
  { label: "heartfelt indie coming-of-age film", category: "movie" },
  { label: "Cold War spy thriller", category: "movie" },
  { label: "post-apocalyptic survival film", category: "movie" },
  { label: "screwball romantic comedy", category: "movie" },
  { label: "samurai revenge film", category: "movie" },
  { label: "claustrophobic single-location thriller", category: "movie" },
  { label: "big-budget superhero origin film", category: "movie" },
  { label: "1940s wartime romance", category: "movie" },
  { label: "low-budget B-movie alien invasion", category: "movie" },
  { label: "prison break caper", category: "movie" },
  { label: "psychological time-loop thriller", category: "movie" },
  { label: "mountaineering survival drama", category: "movie" },
  { label: "mob family crime saga", category: "movie" },
  { label: "haunted house gothic horror", category: "movie" },
  { label: "feel-good underdog sports movie", category: "movie" },
  { label: "1980s teen comedy", category: "movie" },

  // --- tv ---
  { label: "prestige cable crime drama", category: "tv" },
  { label: "multi-camera sitcom with a laugh track", category: "tv" },
  { label: "British period costume drama", category: "tv" },
  { label: "reality competition elimination show", category: "tv" },
  { label: "workplace mockumentary sitcom", category: "tv" },
  { label: "medical hospital drama", category: "tv" },
  { label: "gritty police procedural", category: "tv" },
  { label: "fantasy serialized epic", category: "tv" },
  { label: "late-night talk show monologue", category: "tv" },
  { label: "1990s family sitcom", category: "tv" },
  { label: "true-crime dramatized reenactment series", category: "tv" },
  { label: "cooking competition reality show", category: "tv" },
  { label: "anthology science-fiction series", category: "tv" },
  { label: "home-renovation makeover show", category: "tv" },
  { label: "Saturday morning variety hour", category: "tv" },
  { label: "courtroom reality TV show", category: "tv" },
  { label: "soap-opera-style teen drama", category: "tv" },
  { label: "nature wildlife travelogue series", category: "tv" },
  { label: "improv comedy panel show", category: "tv" },
  { label: "dating competition reality show", category: "tv" },
  { label: "spy-agency action series", category: "tv" },
  { label: "small-town quirky dramedy", category: "tv" },
  { label: "ghost-hunting paranormal investigation show", category: "tv" },
  { label: "high-stakes legal drama series", category: "tv" },
  { label: "survivalist wilderness reality show", category: "tv" },
  { label: "antiques appraisal roadshow", category: "tv" },
  { label: "1980s primetime soap", category: "tv" },
  { label: "celebrity baking showcase", category: "tv" },

  // --- documentary ---
  {
    label: "David-Attenborough-style nature documentary",
    category: "documentary",
  },
  { label: "gripping true-crime documentary", category: "documentary" },
  { label: "Ken-Burns-style historical documentary", category: "documentary" },
  { label: "deep-sea exploration documentary", category: "documentary" },
  { label: "space-program archival documentary", category: "documentary" },
  { label: "wildlife predator-and-prey documentary", category: "documentary" },
  {
    label: "music-festival behind-the-scenes documentary",
    category: "documentary",
  },
  { label: "conspiracy-theory exposé documentary", category: "documentary" },
  { label: "tech-startup rise-and-fall documentary", category: "documentary" },
  {
    label: "volcano and natural-disaster documentary",
    category: "documentary",
  },
  {
    label: "anthropological remote-tribe documentary",
    category: "documentary",
  },
  {
    label: "competitive-eating subculture documentary",
    category: "documentary",
  },
  {
    label: "abandoned-places urban-exploration documentary",
    category: "documentary",
  },
  { label: "cold-case investigative documentary", category: "documentary" },
  { label: "migratory-bird nature documentary", category: "documentary" },
  { label: "art-forgery heist documentary", category: "documentary" },
  { label: "deep-jungle insect documentary", category: "documentary" },
  { label: "cult-survivor testimonial documentary", category: "documentary" },
  { label: "Arctic-expedition survival documentary", category: "documentary" },
  {
    label: "fast-food-industry investigative documentary",
    category: "documentary",
  },
  {
    label: "ancient-civilization archaeology documentary",
    category: "documentary",
  },
  {
    label: "extreme-weather storm-chaser documentary",
    category: "documentary",
  },
  {
    label: "endangered-species conservation documentary",
    category: "documentary",
  },
  { label: "underground-cave-system documentary", category: "documentary" },
  { label: "vintage-arcade subculture documentary", category: "documentary" },
  { label: "shipwreck-salvage documentary", category: "documentary" },
  { label: "rare-mineral mining documentary", category: "documentary" },

  // --- commercial ---
  { label: "80s pharmaceutical commercial", category: "commercial" },
  { label: "home shopping network segment", category: "commercial" },
  {
    label: "late-night infomercial for a kitchen gadget",
    category: "commercial",
  },
  { label: "luxury perfume commercial", category: "commercial" },
  { label: "fast-food value-meal commercial", category: "commercial" },
  { label: "used-car-dealership local TV spot", category: "commercial" },
  { label: "insurance-company mascot commercial", category: "commercial" },
  { label: "energy-drink extreme-sports commercial", category: "commercial" },
  { label: "Super Bowl big-budget beer commercial", category: "commercial" },
  {
    label: "cleaning-product before-and-after commercial",
    category: "commercial",
  },
  { label: "as-seen-on-TV gadget infomercial", category: "commercial" },
  { label: "law-firm injury-attorney commercial", category: "commercial" },
  {
    label: "sentimental holiday department-store commercial",
    category: "commercial",
  },
  { label: "mattress-warehouse blowout-sale spot", category: "commercial" },
  { label: "exercise-equipment fitness infomercial", category: "commercial" },
  {
    label: "fragrance perfume cologne aspirational ad",
    category: "commercial",
  },
  { label: "fast-acting cold-medicine commercial", category: "commercial" },
  { label: "breakfast-cereal jingle commercial", category: "commercial" },
  { label: "high-end automobile luxury commercial", category: "commercial" },
  { label: "pet-food heartwarming commercial", category: "commercial" },
  { label: "tax-preparation-service commercial", category: "commercial" },
  {
    label: "miracle weight-loss-supplement infomercial",
    category: "commercial",
  },
  { label: "fast-internet-provider commercial", category: "commercial" },
  { label: "carpet-store grand-opening spot", category: "commercial" },
  { label: "investment-app fintech commercial", category: "commercial" },
  { label: "old-timey patent-medicine pitch", category: "commercial" },
  { label: "amusement-park summer commercial", category: "commercial" },

  // --- training ---
  { label: "corporate VHS safety training from 1993", category: "training" },
  { label: "workplace harassment compliance video", category: "training" },
  { label: "fast-food employee onboarding video", category: "training" },
  { label: "fire-drill evacuation training video", category: "training" },
  { label: "forklift-operation safety training", category: "training" },
  { label: "customer-service de-escalation training", category: "training" },
  { label: "data-security phishing-awareness training", category: "training" },
  { label: "food-handling hygiene training video", category: "training" },
  { label: "retail loss-prevention training video", category: "training" },
  { label: "call-center scripted-greeting training", category: "training" },
  { label: "OSHA workplace-hazards training video", category: "training" },
  { label: "new-hire HR orientation video", category: "training" },
  {
    label: "warehouse heavy-lifting ergonomics training",
    category: "training",
  },
  { label: "1980s office-etiquette instructional film", category: "training" },
  { label: "hotel-housekeeping standards training", category: "training" },
  { label: "airline-crew emergency-procedure training", category: "training" },
  { label: "bank-teller fraud-detection training", category: "training" },
  { label: "factory-floor machine-operation tutorial", category: "training" },
  {
    label: "telephone-sales-technique instructional video",
    category: "training",
  },
  { label: "lab-coat chemical-safety training film", category: "training" },
  { label: "diversity-and-inclusion workshop video", category: "training" },
  { label: "first-aid-and-CPR instructional video", category: "training" },
  { label: "expense-report-policy compliance video", category: "training" },
  { label: "grocery-store-bagging-technique training", category: "training" },
  { label: "remote-work-productivity webinar", category: "training" },
  { label: "construction-site hard-hat-safety briefing", category: "training" },
  { label: "cubicle-etiquette corporate training reel", category: "training" },

  // --- radio ---
  { label: "noir detective radio drama", category: "radio" },
  { label: "1940s wartime radio newsreel", category: "radio" },
  { label: "late-night call-in talk-radio show", category: "radio" },
  { label: "old-time radio mystery serial", category: "radio" },
  { label: "morning-zoo drive-time radio bit", category: "radio" },
  { label: "smooth-jazz overnight radio program", category: "radio" },
  { label: "sci-fi radio anthology with sound effects", category: "radio" },
  { label: "true-crime investigative podcast", category: "radio" },
  { label: "sports talk-radio hot-take segment", category: "radio" },
  { label: "public-radio pledge-drive break", category: "radio" },
  { label: "AM-radio conspiracy late-night broadcast", category: "radio" },
  { label: "country-music request-line radio hour", category: "radio" },
  { label: "Western-frontier radio drama", category: "radio" },
  { label: "self-help motivational radio segment", category: "radio" },
  { label: "1930s comedy-variety radio hour", category: "radio" },
  { label: "weather-and-traffic radio update", category: "radio" },
  { label: "horror anthology radio play", category: "radio" },
  { label: "financial-advice call-in radio show", category: "radio" },
  { label: "college-radio indie-music DJ set", category: "radio" },
  { label: "emergency-broadcast-system bulletin", category: "radio" },
  { label: "gardening-tips weekend radio program", category: "radio" },
  { label: "swing-era big-band radio broadcast", category: "radio" },
  { label: "advice-column relationship radio show", category: "radio" },
  { label: "ghost-story campfire radio narration", category: "radio" },
  { label: "shipping-forecast monotone radio reading", category: "radio" },
  { label: "pirate-radio late-night rebel broadcast", category: "radio" },
  { label: "polka-hour community radio program", category: "radio" },

  // --- sports ---
  {
    label: "play-by-play football championship commentary",
    category: "sports",
  },
  { label: "hushed golf-tournament broadcast", category: "sports" },
  { label: "frenzied horse-race call", category: "sports" },
  { label: "Olympic figure-skating commentary", category: "sports" },
  { label: "boxing-match ringside commentary", category: "sports" },
  { label: "competitive sourdough baking championship", category: "sports" },
  { label: "high-stakes chess-tournament commentary", category: "sports" },
  { label: "monster-truck-rally announcing", category: "sports" },
  { label: "World Cup soccer match commentary", category: "sports" },
  { label: "extreme-skateboarding competition commentary", category: "sports" },
  { label: "professional-wrestling ringside hype", category: "sports" },
  { label: "Tour-de-France cycling commentary", category: "sports" },
  { label: "esports tournament shoutcasting", category: "sports" },
  { label: "synchronized-swimming Olympic commentary", category: "sports" },
  { label: "demolition-derby announcing", category: "sports" },
  { label: "Formula-1 pit-lane commentary", category: "sports" },
  { label: "dog-show breed-judging commentary", category: "sports" },
  { label: "competitive-eating contest play-by-play", category: "sports" },
  { label: "marathon finish-line commentary", category: "sports" },
  { label: "darts-championship pub commentary", category: "sports" },
  { label: "rodeo bull-riding announcing", category: "sports" },
  { label: "curling-match technical commentary", category: "sports" },
  { label: "ping-pong-championship rapid-fire commentary", category: "sports" },
  {
    label: "lumberjack-competition log-rolling commentary",
    category: "sports",
  },
  { label: "spelling-bee tension-filled commentary", category: "sports" },
  { label: "drone-racing first-person commentary", category: "sports" },
  { label: "competitive-yo-yo-freestyle commentary", category: "sports" },

  // --- game_show ---
  {
    label: "high-energy wheel-spinning game show intro",
    category: "game_show",
  },
  { label: "trivia-quiz-show buzzer round", category: "game_show" },
  { label: "dating game show", category: "game_show" },
  { label: "1970s pricing game show", category: "game_show" },
  { label: "physical-obstacle-course game show", category: "game_show" },
  { label: "money-ladder quiz game show", category: "game_show" },
  { label: "celebrity-panel guessing game show", category: "game_show" },
  { label: "word-puzzle letter-board game show", category: "game_show" },
  { label: "family-survey face-off game show", category: "game_show" },
  {
    label: "supermarket-sweep timed-shopping game show",
    category: "game_show",
  },
  { label: "deal-or-no-deal briefcase game show", category: "game_show" },
  { label: "kids' messy-stunt game show", category: "game_show" },
  { label: "lightning-round speed-trivia game show", category: "game_show" },
  { label: "Japanese-style endurance game show", category: "game_show" },
  { label: "matchmaking blind-date game show", category: "game_show" },
  { label: "spin-the-wheel jackpot game show", category: "game_show" },
  { label: "musical-name-that-tune game show", category: "game_show" },
  { label: "high-stakes final-question game show", category: "game_show" },
  { label: "audience-participation prize game show", category: "game_show" },
  { label: "geography-trivia globe-trotting game show", category: "game_show" },
  { label: "tag-team couples game show", category: "game_show" },
  { label: "rapid-fire general-knowledge game show", category: "game_show" },
  { label: "bargain-hunting auction game show", category: "game_show" },
  { label: "retro neon-set 80s game show", category: "game_show" },
  { label: "memory-recall matching game show", category: "game_show" },
  { label: "physical-challenge gladiator game show", category: "game_show" },
  { label: "puzzle-box escape-room game show", category: "game_show" },

  // --- soap ---
  { label: "melodramatic daytime soap opera", category: "soap" },
  { label: "long-lost-twin reveal soap opera", category: "soap" },
  { label: "hospital-romance soap opera", category: "soap" },
  { label: "wealthy-family-feud soap opera", category: "soap" },
  { label: "amnesia-plotline soap opera", category: "soap" },
  { label: "small-town secrets soap opera", category: "soap" },
  { label: "courtroom-cliffhanger soap opera", category: "soap" },
  { label: "love-triangle soap opera", category: "soap" },
  { label: "evil-twin sabotage soap opera", category: "soap" },
  { label: "fashion-empire rivalry soap opera", category: "soap" },
  { label: "back-from-the-dead soap opera", category: "soap" },
  { label: "boardroom-betrayal soap opera", category: "soap" },
  { label: "secret-baby paternity soap opera", category: "soap" },
  { label: "Spanish-language telenovela", category: "soap" },
  { label: "scheming-matriarch soap opera", category: "soap" },
  { label: "wedding-interrupted soap opera", category: "soap" },
  { label: "inheritance-dispute soap opera", category: "soap" },
  { label: "forbidden-romance soap opera", category: "soap" },
  { label: "missing-fortune soap opera", category: "soap" },
  { label: "double-life deception soap opera", category: "soap" },
  { label: "dramatic-slap confrontation soap opera", category: "soap" },
  { label: "coma-awakening soap opera", category: "soap" },
  { label: "vineyard-dynasty soap opera", category: "soap" },
  { label: "blackmail-conspiracy soap opera", category: "soap" },
  { label: "mistaken-identity soap opera", category: "soap" },
  { label: "rags-to-riches soap opera", category: "soap" },
  { label: "rival-sisters soap opera", category: "soap" },

  // --- news ---
  { label: "breaking-news special report", category: "news" },
  { label: "NASA mission control briefing", category: "news" },
  { label: "local-evening-news anchor desk", category: "news" },
  { label: "on-the-scene field-reporter live shot", category: "news" },
  { label: "24-hour cable-news panel debate", category: "news" },
  { label: "weather-forecast meteorologist segment", category: "news" },
  { label: "investigative-journalism exposé segment", category: "news" },
  { label: "morning-show light-news segment", category: "news" },
  { label: "financial-markets closing-bell report", category: "news" },
  { label: "war-correspondent frontline dispatch", category: "news" },
  { label: "press-conference podium briefing", category: "news" },
  { label: "human-interest feel-good news story", category: "news" },
  { label: "election-night results coverage", category: "news" },
  { label: "traffic-helicopter aerial report", category: "news" },
  { label: "sports-desk highlight-reel recap", category: "news" },
  { label: "consumer-watchdog investigative segment", category: "news" },
  { label: "international-correspondent foreign report", category: "news" },
  { label: "town-hall live-audience news special", category: "news" },
  { label: "1950s newsreel cinema bulletin", category: "news" },
  { label: "tech-industry breaking-news alert", category: "news" },
  { label: "courthouse-steps reporter scrum", category: "news" },
  { label: "late-breaking severe-weather alert", category: "news" },
  { label: "investigative-documentary news magazine", category: "news" },
  { label: "stock-ticker financial-news crawl", category: "news" },
  { label: "anchor-to-correspondent live toss", category: "news" },
  { label: "satellite-delay foreign-bureau report", category: "news" },
  { label: "viral-video human-interest segment", category: "news" },

  // --- kids ---
  { label: "cheerful preschool puppet show", category: "kids" },
  { label: "educational counting-and-shapes cartoon", category: "kids" },
  { label: "Saturday-morning superhero cartoon", category: "kids" },
  { label: "sing-along nursery-rhyme show", category: "kids" },
  { label: "friendly-neighborhood live-action kids' show", category: "kids" },
  { label: "claymation stop-motion adventure", category: "kids" },
  { label: "talking-animal forest cartoon", category: "kids" },
  { label: "interactive ask-the-audience kids' show", category: "kids" },
  { label: "alphabet-learning muppet segment", category: "kids" },
  { label: "magical-fairy-tale kids' cartoon", category: "kids" },
  { label: "science-experiment kids' edutainment show", category: "kids" },
  { label: "robot-and-dinosaur action cartoon", category: "kids" },
  { label: "gentle bedtime-story narration", category: "kids" },
  { label: "candy-colored toy commercial cartoon", category: "kids" },
  { label: "underwater-adventure kids' cartoon", category: "kids" },
  { label: "space-explorer kids' cartoon", category: "kids" },
  { label: "friendship-lesson moral cartoon", category: "kids" },
  { label: "musical-instrument-teaching kids' show", category: "kids" },
  { label: "silly-mascot dance-along segment", category: "kids" },
  { label: "pirate-treasure-hunt kids' show", category: "kids" },
  { label: "kindness-themed puppet skit", category: "kids" },
  { label: "anime-style kids' adventure series", category: "kids" },
  { label: "barnyard-animals farm cartoon", category: "kids" },
  { label: "cooking-with-kids craft segment", category: "kids" },
  { label: "dinosaur-fact educational cartoon", category: "kids" },
  { label: "superhero-pet sidekick cartoon", category: "kids" },
  { label: "color-and-emotion learning show", category: "kids" },
];

export type StyleId = "prose" | "poem" | "limerick" | "haiku" | "song_verse";

export interface Style {
  id: StyleId;
  weight: number;
}

/**
 * Narration delivery styles. Prose dominates; the creative forms fire rarely
 * (~12% combined) so they stay a delightful surprise rather than a gimmick.
 * Weights sum to 100 (asserted in tests).
 */
export const STYLES: Style[] = [
  { id: "prose", weight: 88 },
  { id: "poem", weight: 5 },
  { id: "limerick", weight: 3 },
  { id: "haiku", weight: 2 },
  { id: "song_verse", weight: 2 },
];

/**
 * Pure, total weighted-index selector. `cumulative` is a running-sum array
 * (e.g. [88, 93, 96, 98, 100]); `r` is in [0, 1). Returns the first index whose
 * cumulative weight strictly exceeds `r * total`, which makes a leading zero
 * weight unselectable (r=0 lands on the first positive-weight bucket). Guarded
 * so boundary `r` values and an all-zero (total 0) list return 0 rather than
 * throwing or yielding -1.
 */
export function weightedIndex(cumulative: number[], r: number): number {
  if (cumulative.length === 0) {
    return 0;
  }
  const total = cumulative.at(-1) ?? 0;
  if (total <= 0) {
    return 0;
  }
  // Clamp r into [0, 1) so a stray 1 (or negative) can't escape the buckets.
  const clamped = Math.min(Math.max(r, 0), 0.999_999_999);
  const target = clamped * total;
  for (let i = 0; i < cumulative.length; i++) {
    if ((cumulative[i] ?? 0) > target) {
      return i;
    }
  }
  return 0;
}

/** Fisher-Yates shuffle on a copy — never mutates the input. */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/**
 * Draw `count` distinct themes at random (default 3) for the LLM to mix and
 * match. A `count` larger than the catalog returns the whole catalog, shuffled.
 */
export function selectThemes(count = 3): Theme[] {
  return shuffled(THEMES).slice(0, Math.max(0, count));
}

/** Weighted random style draw — ~12% chance of a non-prose creative form. */
export function selectStyle(): StyleId {
  let running = 0;
  const cumulative = STYLES.map((style) => {
    running += style.weight;
    return running;
  });
  return STYLES[weightedIndex(cumulative, Math.random())]?.id ?? "prose";
}
