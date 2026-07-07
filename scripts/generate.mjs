#!/usr/bin/env node
/**
 * Self-hosted profile README stats generator.
 * Fetches commit/contribution, language, and repo stats via the GitHub
 * GraphQL API and renders an SVG card.
 *
 * Required env:
 *   GH_TOKEN   - token with read access (repo, read:user) — GITHUB_TOKEN works for public data
 *   GH_LOGIN   - your GitHub username (defaults to repo owner in Actions)
 */

import fs from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const LOGIN = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;

if (!TOKEN || !LOGIN) {
  console.error("Missing GH_TOKEN or GH_LOGIN/GITHUB_REPOSITORY_OWNER");
  process.exit(1);
}

const GQL_ENDPOINT = "https://api.github.com/graphql";

async function gql(query, variables = {}) {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error(JSON.stringify(json.errors, null, 2));
    throw new Error("GraphQL request failed");
  }
  return json.data;
}

/* ---------------------------------------------------------------------- */
/* Data fetching                                                          */
/* ---------------------------------------------------------------------- */

async function fetchProfile() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        name
        login
        createdAt
        followers { totalCount }
        following { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalRepositoryContributions
          totalPullRequestReviewContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                color
              }
            }
          }
        }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
          totalCount
          nodes {
            name
            stargazerCount
            forkCount
            primaryLanguage { name color }
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node { name color }
              }
            }
          }
        }
      }
    }
  `;
  const data = await gql(query, { login: LOGIN });
  return data.user;
}

/* ---------------------------------------------------------------------- */
/* Derived stats                                                          */
/* ---------------------------------------------------------------------- */

function computeStreaks(weeks) {
  const days = weeks.flatMap((w) => w.contributionDays);
  let longest = 0;
  let current = 0;
  let running = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.date > today) continue;
    if (day.contributionCount > 0) {
      current += 1;
    } else if (day.date === today) {
      continue;
    } else {
      break;
    }
  }

  return { longest, current };
}

function computeLanguages(repos) {
  const totals = new Map();
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      const prev = totals.get(name) || { size: 0, color: edge.node.color };
      prev.size += edge.size;
      totals.set(name, prev);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b.size, 0) || 1;
  return [...totals.entries()]
    .map(([name, { size, color }]) => ({
      name,
      color: color || "#8b949e",
      pct: (size / sum) * 100,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
}

function computeRepoStats(repos) {
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
  const forks = repos.reduce((a, r) => a + r.forkCount, 0);
  const top = [...repos].sort((a, b) => b.stargazerCount - a.stargazerCount).slice(0, 5);
  return { stars, forks, top, count: repos.length };
}

function accountAgeYears(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

/* ---------------------------------------------------------------------- */
/* SVG rendering — GitHub Dark (Primer) palette                           */
/* ---------------------------------------------------------------------- */

const THEME = {
  canvas: "#0d1117",      // canvas.default
  canvasSubtle: "#161b22", // canvas.subtle
  border: "#30363d",       // border.default
  fg: "#c9d1d9",            // fg.default
  fgMuted: "#8b949e",       // fg.muted
  fgSubtle: "#6e7681",      // fg.subtle
  blue: "#58a6ff",          // accent.fg
  green: "#3fb950",         // success.fg
  yellow: "#d29922",        // attention.fg
  orange: "#db6d28",        // severe.fg
  red: "#f85149",           // danger.fg
  purple: "#a371f7",        // done.fg
  pink: "#db61a2",          // sponsors.fg
};

// GitHub's actual contribution-square scale (dark mode)
const HEATMAP_SCALE = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

function heatmapLevel(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function renderHeatmap(weeks, x, y) {
  const cell = 10;
  const gap = 3;
  const recentWeeks = weeks.slice(-52);

  const squares = recentWeeks
    .map((week, wi) => {
      return week.contributionDays
        .map((day, di) => {
          const level = heatmapLevel(day.contributionCount);
          const cx = x + wi * (cell + gap);
          const cy = y + di * (cell + gap);
          return `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="2" fill="${HEATMAP_SCALE[level]}"><title>${day.date}: ${day.contributionCount}</title></rect>`;
        })
        .join("");
    })
    .join("");

  const legendX = x + recentWeeks.length * (cell + gap) - 90;
  const legendY = y + 7 * (cell + gap) + 14;
  const legend = HEATMAP_SCALE
    .map((c, i) => `<rect x="${legendX + i * 14}" y="${legendY - 9}" width="10" height="10" rx="2" fill="${c}"/>`)
    .join("");

  return `
    <text x="${x}" y="${y - 10}" fill="${THEME.fgMuted}" font-size="13" font-weight="600" font-family="'Segoe UI', sans-serif" letter-spacing="1">CONTRIBUTION ACTIVITY (52 WEEKS)</text>
    ${squares}
    <text x="${legendX - 30}" y="${legendY}" fill="${THEME.fgSubtle}" font-size="10" font-family="'Segoe UI', sans-serif">less</text>
    ${legend}
    <text x="${legendX + HEATMAP_SCALE.length * 14 + 4}" y="${legendY}" fill="${THEME.fgSubtle}" font-size="10" font-family="'Segoe UI', sans-serif">more</text>
  `;
}

function renderRepoChart(repos, x, y, width) {
  if (repos.length === 0) return "";
  const maxStars = Math.max(...repos.map((r) => r.stargazerCount), 1);
  const rowH = 26;
  const barMaxW = width - 220;

  const rows = repos
    .map((r, i) => {
      const ry = y + i * rowH;
      const barW = Math.max((r.stargazerCount / maxStars) * barMaxW, 2);
      const lang = r.primaryLanguage?.color || THEME.fgMuted;
      return `
        <text x="${x}" y="${ry + 14}" fill="${THEME.fg}" font-size="13" font-family="'Segoe UI', sans-serif">${escapeXml(r.name)}</text>
        <rect x="${x + 170}" y="${ry + 3}" width="${barW.toFixed(1)}" height="12" rx="3" fill="${lang}"/>
        <text x="${x + 170 + barMaxW + 10}" y="${ry + 13}" fill="${THEME.fgMuted}" font-size="12" font-family="'Segoe UI', sans-serif">★ ${r.stargazerCount}</text>
      `;
    })
    .join("");

  return `
    <text x="${x}" y="${y - 14}" fill="${THEME.fgMuted}" font-size="13" font-weight="600" font-family="'Segoe UI', sans-serif" letter-spacing="1">TOP REPOSITORIES</text>
    ${rows}
  `;
}

function renderCard({ profile, streaks, languages, repoStats, weeks }) {
  const W = 900;
  const H = 900;
  const accent = [THEME.purple, THEME.blue, THEME.green, THEME.yellow, THEME.orange, THEME.pink];
  const cc = profile.contributionsCollection;

  const statItems = [
    { label: "Total Stars", value: repoStats.stars },
    { label: "Public Repos", value: repoStats.count },
    { label: "Followers", value: profile.followers.totalCount },
    { label: "Contributions (yr)", value: cc.contributionCalendar.totalContributions },
    { label: "Current Streak", value: `${streaks.current}d` },
    { label: "Longest Streak", value: `${streaks.longest}d` },
    { label: "Pull Requests", value: cc.totalPullRequestContributions },
    { label: "Issues Opened", value: cc.totalIssueContributions },
    { label: "Code Reviews", value: cc.totalPullRequestReviewContributions },
    { label: "Account Age", value: `${accountAgeYears(profile.createdAt)}y` },
  ];

  const statBlocks = statItems
    .map((item, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 40 + col * 270;
      const y = 130 + row * 90;
      return `
        <g transform="translate(${x}, ${y})">
          <text x="0" y="0" fill="${THEME.fgMuted}" font-size="13" font-family="'Segoe UI', sans-serif">${escapeXml(item.label)}</text>
          <text x="0" y="30" fill="${accent[i % accent.length]}" font-size="26" font-weight="700" font-family="'Segoe UI', sans-serif">${escapeXml(item.value)}</text>
        </g>`;
    })
    .join("");

  const langY = 500;
  const barX = 40;
  const barW = 820;
  let cursor = 0;
  const langBars = languages
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const rect = `<rect x="${barX + cursor}" y="${langY}" width="${w.toFixed(2)}" height="14" fill="${l.color}" rx="2"/>`;
      cursor += w;
      return rect;
    })
    .join("");

  const langLegend = languages
    .map((l, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 40 + col * 270;
      const y = 540 + row * 26;
      return `
        <g transform="translate(${x}, ${y})">
          <rect x="0" y="-10" width="10" height="10" rx="2" fill="${l.color}"/>
          <text x="16" y="-1" fill="${THEME.fg}" font-size="13" font-family="'Segoe UI', sans-serif">${escapeXml(l.name)} ${l.pct.toFixed(1)}%</text>
        </g>`;
    })
    .join("");

  const heatmap = renderHeatmap(weeks, 40, 660);
  const repoChart = renderRepoChart(repoStats.top, 40, 800, barW);

  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="rounded"><rect x="0" y="0" width="${W}" height="${H}" rx="18"/></clipPath>
    <linearGradient id="headerGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${THEME.purple}"/>
      <stop offset="100%" stop-color="${THEME.blue}"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#rounded)">
    <rect width="${W}" height="${H}" fill="${THEME.canvas}"/>
    <rect width="${W}" height="6" fill="url(#headerGrad)"/>
    <text x="40" y="55" fill="${THEME.fg}" font-size="26" font-weight="700" font-family="'Segoe UI', sans-serif">${escapeXml(profile.name || profile.login)}</text>
    <text x="40" y="80" fill="${THEME.fgSubtle}" font-size="14" font-family="'Segoe UI', sans-serif">@${escapeXml(profile.login)} · on GitHub since ${new Date(profile.createdAt).getFullYear()}</text>
    <line x1="40" y1="100" x2="${W - 40}" y2="100" stroke="${THEME.border}" stroke-width="1"/>

    ${statBlocks}

    <text x="40" y="470" fill="${THEME.fgMuted}" font-size="13" font-weight="600" font-family="'Segoe UI', sans-serif" letter-spacing="1">TOP LANGUAGES</text>
    <rect x="${barX}" y="${langY}" width="${barW}" height="14" rx="7" fill="${THEME.canvasSubtle}"/>
    ${langBars}
    ${langLegend}

    ${heatmap}
    ${repoChart}

    <text x="${W - 40}" y="${H - 18}" fill="${THEME.fgSubtle}" font-size="11" text-anchor="end" font-family="'Segoe UI', sans-serif">generated ${generated}</text>
  </g>
</svg>`;
}

/* ---------------------------------------------------------------------- */
/* Main                                                                    */
/* ---------------------------------------------------------------------- */

async function main() {
  const profile = await fetchProfile();
  const repos = profile.repositories.nodes;
  const weeks = profile.contributionsCollection.contributionCalendar.weeks;

  const streaks = computeStreaks(weeks);
  const languages = computeLanguages(repos);
  const repoStats = computeRepoStats(repos);

  const svg = renderCard({ profile, streaks, languages, repoStats, weeks });

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/stats.svg", svg, "utf8");

  console.log("Wrote assets/stats.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
