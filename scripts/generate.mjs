#!/usr/bin/env node
/**
 * Self-hosted profile README stats generator.
 * Fetches commit/contribution, language, and repo stats via the GitHub
 * GraphQL + REST APIs, renders an SVG card, and writes README.md.
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
const REST_ENDPOINT = "https://api.github.com";

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

async function rest(path) {
  const res = await fetch(`${REST_ENDPOINT}${path}`, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`REST ${path} failed: ${res.status}`);
  return res.json();
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
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
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

  // current streak: walk backwards from most recent day
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.date > today) continue;
    if (day.contributionCount > 0) {
      current += 1;
    } else if (day.date === today) {
      continue; // today can still be 0 without breaking the streak
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
      color: color || "#8b8b8b",
      pct: (size / sum) * 100,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
}

function computeRepoStats(repos) {
  const stars = repos.reduce((a, r) => a + r.stargazerCount, 0);
  const forks = repos.reduce((a, r) => a + r.forkCount, 0);
  const top = [...repos].sort((a, b) => b.stargazerCount - a.stargazerCount).slice(0, 3);
  return { stars, forks, top, count: repos.length };
}

/* ---------------------------------------------------------------------- */
/* SVG rendering — Catppuccin Mocha palette                               */
/* ---------------------------------------------------------------------- */

const THEME = {
  base: "#1e1e2e",
  mantle: "#181825",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  overlay: "#6c7086",
  surface: "#313244",
  mauve: "#cba6f7",
  blue: "#89b4fa",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  pink: "#f5c2e7",
  red: "#f38ba8",
};

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

function renderCard({ profile, streaks, languages, repoStats }) {
  const W = 900;
  const H = 460;
  const accent = [THEME.mauve, THEME.blue, THEME.green, THEME.yellow, THEME.peach, THEME.pink];

  const statItems = [
    { label: "Total Stars", value: repoStats.stars },
    { label: "Public Repos", value: repoStats.count },
    { label: "Followers", value: profile.followers.totalCount },
    { label: "Contributions (yr)", value: profile.contributionsCollection.contributionCalendar.totalContributions },
    { label: "Current Streak", value: `${streaks.current}d` },
    { label: "Longest Streak", value: `${streaks.longest}d` },
  ];

  const statBlocks = statItems
    .map((item, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 40 + col * 270;
      const y = 130 + row * 90;
      return `
        <g transform="translate(${x}, ${y})">
          <text x="0" y="0" fill="${THEME.subtext}" font-size="13" font-family="'Segoe UI', sans-serif">${escapeXml(item.label)}</text>
          <text x="0" y="30" fill="${accent[i % accent.length]}" font-size="28" font-weight="700" font-family="'Segoe UI', sans-serif">${escapeXml(item.value)}</text>
        </g>`;
    })
    .join("");

  let langY = 330;
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
      const y = 370 + row * 26;
      return `
        <g transform="translate(${x}, ${y})">
          <rect x="0" y="-10" width="10" height="10" rx="2" fill="${l.color}"/>
          <text x="16" y="-1" fill="${THEME.text}" font-size="13" font-family="'Segoe UI', sans-serif">${escapeXml(l.name)} ${l.pct.toFixed(1)}%</text>
        </g>`;
    })
    .join("");

  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="rounded"><rect x="0" y="0" width="${W}" height="${H}" rx="18"/></clipPath>
    <linearGradient id="headerGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${THEME.mauve}"/>
      <stop offset="100%" stop-color="${THEME.blue}"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#rounded)">
    <rect width="${W}" height="${H}" fill="${THEME.base}"/>
    <rect width="${W}" height="6" fill="url(#headerGrad)"/>
    <text x="40" y="55" fill="${THEME.text}" font-size="26" font-weight="700" font-family="'Segoe UI', sans-serif">${escapeXml(profile.name || profile.login)}</text>
    <text x="40" y="80" fill="${THEME.overlay}" font-size="14" font-family="'Segoe UI', sans-serif">@${escapeXml(profile.login)} · on GitHub since ${new Date(profile.createdAt).getFullYear()}</text>
    <line x1="40" y1="100" x2="${W - 40}" y2="100" stroke="${THEME.surface}" stroke-width="1"/>

    ${statBlocks}

    <text x="40" y="300" fill="${THEME.subtext}" font-size="13" font-weight="600" font-family="'Segoe UI', sans-serif" letter-spacing="1">TOP LANGUAGES</text>
    <rect x="${barX}" y="${langY}" width="${barW}" height="14" rx="7" fill="${THEME.surface}"/>
    ${langBars}
    ${langLegend}

    <text x="${W - 40}" y="${H - 18}" fill="${THEME.overlay}" font-size="11" text-anchor="end" font-family="'Segoe UI', sans-serif">generated ${generated}</text>
  </g>
</svg>`;
}

/* ---------------------------------------------------------------------- */
/* README assembly                                                        */
/* ---------------------------------------------------------------------- */

function renderReadme({ profile, repoStats }) {
  const topRepos = repoStats.top
    .map((r) => `- **${r.name}** — ★ ${r.stargazerCount} · ${r.primaryLanguage?.name ?? "—"}`)
    .join("\n");

  return `<div align="center">

# Hi, I'm ${profile.name || profile.login} 👋

<img src="./assets/stats.svg" alt="GitHub stats card" width="900"/>

### Top Repos

${topRepos}

<sub>Card auto-generated by <code>scripts/generate.mjs</code> via GitHub Actions — see <code>.github/workflows/metrics.yml</code></sub>

</div>
`;
}

/* ---------------------------------------------------------------------- */
/* Main                                                                    */
/* ---------------------------------------------------------------------- */

async function main() {
  const profile = await fetchProfile();
  const repos = profile.repositories.nodes;

  const streaks = computeStreaks(profile.contributionsCollection.contributionCalendar.weeks);
  const languages = computeLanguages(repos);
  const repoStats = computeRepoStats(repos);

  const svg = renderCard({ profile, streaks, languages, repoStats });
  const readme = renderReadme({ profile, repoStats });

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/stats.svg", svg, "utf8");
  await fs.writeFile("README.md", readme, "utf8");

  console.log("Wrote assets/stats.svg and README.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
