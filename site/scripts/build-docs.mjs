import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(scriptsDir, '..');
const publicDir = join(siteRoot, 'public');
const siteUrl = 'https://endpointx.onrender.com';

const SLUGS = ['visao-geral', 'instalacao', 'agentes', 'discovery', 'seguranca', 'faq'];
const LANGS = ['pt', 'en'];
const CONTENT_DIR = { pt: join(siteRoot, 'content', 'docs', 'pt'), en: join(siteRoot, 'content', 'docs', 'en') };
const OUT_DIR = { pt: join(siteRoot, 'docs'), en: join(siteRoot, 'en', 'docs') };
const URL_PREFIX = { pt: '/docs', en: '/en/docs' };
const HTML_LANG = { pt: 'pt-PT', en: 'en' };

const UI = {
  pt: {
    navDocs: 'Documentação',
    searchPlaceholder: 'Pesquisar na documentação…',
    sideTitle: 'Documentação',
    tocLabel: 'Nesta página',
    copy: 'Copiar',
    empty: 'Nenhum resultado encontrado.',
    langSwitchLabel: 'Ver em English →',
    titles: {
      'visao-geral': 'Visão geral da plataforma',
      instalacao: 'Instalação e requisitos',
      agentes: 'Gestão de agentes',
      discovery: 'Network Discovery',
      seguranca: 'Segurança e permissões',
      faq: 'Perguntas frequentes',
    },
  },
  en: {
    navDocs: 'Documentation',
    searchPlaceholder: 'Search the documentation…',
    sideTitle: 'Documentation',
    tocLabel: 'On this page',
    copy: 'Copy',
    empty: 'No results found.',
    langSwitchLabel: 'View in Portuguese →',
    titles: {
      'visao-geral': 'Platform overview',
      instalacao: 'Installation and requirements',
      agentes: 'Agent management',
      discovery: 'Network Discovery',
      seguranca: 'Security and permissions',
      faq: 'Frequently asked questions',
    },
  },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function slugifyHeading(text) {
  const base = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'sec';
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) data[key] = value;
  }
  return { data, body: raw.slice(match[0].length) };
}

function addHeadingIds(html) {
  const used = new Map();
  const headings = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    const plain = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    let id = slugifyHeading(plain);
    const seen = (used.get(id) || 0) + 1;
    used.set(id, seen);
    if (seen > 1) id = `${id}-${seen}`;
    if (level === '2') headings.push({ id, text: plain });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, headings };
}

function wrapCallouts(html) {
  return html.replace(
    /<blockquote>\s*<p><strong>(Nota:|Note:)<\/strong>([\s\S]*?)<\/p>\s*<\/blockquote>/g,
    '<div class="docs-callout"><strong>$1</strong>$2</div>'
  );
}

function wrapCodeBlocks(html, copyLabel) {
  return html.replace(/<pre><code(?: class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (match, cls, code) => {
    const codeTag = cls ? `<code class="${cls}">` : '<code>';
    return (
      `<div class="code-block">` +
      `<button class="copy-btn" type="button" aria-label="${copyLabel}">${copyLabel}</button>` +
      `<pre>${codeTag}${code}</code></pre></div>`
    );
  });
}

function renderToc(headings, label) {
  if (headings.length < 2) return '';
  const items = headings.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('');
  return `<nav class="docs-toc"><span class="k">${escapeHtml(label)}</span><ol>${items}</ol></nav>`;
}

function renderSidebar(lang, slug, pageTitles) {
  const ui = UI[lang];
  const prefix = URL_PREFIX[lang];
  const links = SLUGS.map((s) => {
    const label = escapeHtml(pageTitles[s] || ui.titles[s]);
    const active = s === slug ? ' class="active"' : '';
    return `<a href="${prefix}/${s}"${active} data-slug="${s}">${label}</a>`;
  }).join('\n');
  return (
    `<nav aria-label="${escapeHtml(ui.sideTitle)}">\n${links}\n</nav>\n` +
    `<div class="docs-empty">${escapeHtml(ui.empty)}</div>`
  );
}

function fillTemplate(template, values) {
  let html = template;
  for (const [key, value] of Object.entries(values)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}

/* ---------- existência e paridade PT/EN ---------- */
let parityFailed = false;
const present = new Map();
for (const slug of SLUGS) {
  const ptPath = join(CONTENT_DIR.pt, `${slug}.md`);
  const enPath = join(CONTENT_DIR.en, `${slug}.md`);
  const ptHas = existsSync(ptPath);
  const enHas = existsSync(enPath);
  present.set(slug, { pt: ptHas, en: enHas });
  if (ptHas !== enHas) {
    console.error(`[build-docs] ERRO: slug "${slug}" tem markdown apenas num idioma (pt=${ptHas}, en=${enHas}).`);
    parityFailed = true;
  } else if (!ptHas) {
    console.warn(`[build-docs] aviso: slug "${slug}" sem markdown em nenhum idioma — a saltar.`);
  }
}

/* ---------- parse + render ---------- */
const template = readFileSync(join(scriptsDir, 'docs-template.html'), 'utf8');
const pages = { pt: [], en: [] };
const pageTitles = { pt: {}, en: {} };

for (const lang of LANGS) {
  const ui = UI[lang];
  for (const slug of SLUGS) {
    const flags = present.get(slug);
    if (!flags[lang] || !(flags.pt && flags.en)) continue;
    const raw = readFileSync(join(CONTENT_DIR[lang], `${slug}.md`), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const title = data.title || ui.titles[slug];
    const lead = data.lead || '';
    const description = data.description || '';
    let html = marked.parse(body, { gfm: true });
    const withIds = addHeadingIds(html);
    html = withIds.html;
    html = wrapCallouts(html);
    html = wrapCodeBlocks(html, ui.copy);
    pageTitles[lang][slug] = title;
    pages[lang].push({
      slug,
      title,
      lead,
      description,
      html,
      headings: withIds.headings,
      text: decodeEntities(withIds.html.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000),
    });
  }
}

/* ---------- gerar HTML ---------- */
for (const lang of LANGS) {
  const ui = UI[lang];
  const prefix = URL_PREFIX[lang];
  const other = lang === 'pt' ? 'en' : 'pt';
  mkdirSync(OUT_DIR[lang], { recursive: true });
  for (const page of pages[lang]) {
    const index = SLUGS.indexOf(page.slug);
    const prev = index > 0 ? SLUGS[index - 1] : null;
    const next = index < SLUGS.length - 1 ? SLUGS[index + 1] : null;
    const html = fillTemplate(template, {
      lang: HTML_LANG[lang],
      title: escapeHtml(page.title),
      description: escapeHtml(page.description),
      canonical: `${siteUrl}${prefix}/${page.slug}`,
      hreflang_pt: `${siteUrl}/docs/${page.slug}`,
      hreflang_en: `${siteUrl}/en/docs/${page.slug}`,
      nav_docs_label: escapeHtml(ui.navDocs),
      search_placeholder: escapeHtml(ui.searchPlaceholder),
      side_title: escapeHtml(ui.sideTitle),
      sidebar: renderSidebar(lang, page.slug, pageTitles[lang]),
      lang_switch_href: `${URL_PREFIX[other]}/${page.slug}`,
      lang_switch_label: escapeHtml(ui.langSwitchLabel),
      lead: escapeHtml(page.lead),
      toc: renderToc(page.headings, ui.tocLabel),
      body: page.html,
      prev_href: prev ? `${prefix}/${prev}` : '##none##',
      prev_label: escapeHtml(prev ? pageTitles[lang][prev] || ui.titles[prev] : ''),
      next_href: next ? `${prefix}/${next}` : '##none##',
      next_label: escapeHtml(next ? pageTitles[lang][next] || ui.titles[next] : ''),
      copy_label: escapeHtml(ui.copy),
      year: String(new Date().getFullYear()),
    })
      .replace(/<a class="docs-prev" href="##none##">[\s\S]*?<\/a>/, '<span></span>')
      .replace(/<a class="docs-next" href="##none##">[\s\S]*?<\/a>/, '<span></span>');

    const leftover = html.match(/\{\{[a-z_]+\}\}/g);
    if (leftover) console.warn(`[build-docs] aviso: placeholders por preencher em ${lang}/${page.slug}: ${[...new Set(leftover)].join(', ')}`);

    const outFile = join(OUT_DIR[lang], `${page.slug}.html`);
    writeFileSync(outFile, html);
    console.log(`[build-docs] escrito ${outFile}`);
  }
}

/* ---------- search-index.json ---------- */
const searchIndex = [];
for (const lang of LANGS) {
  for (const page of pages[lang]) {
    searchIndex.push({
      lang,
      slug: page.slug,
      title: page.title,
      lead: page.lead,
      url: `${URL_PREFIX[lang]}/${page.slug}`,
      headings: page.headings,
      text: page.text,
    });
  }
}
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, 'search-index.json'), JSON.stringify(searchIndex, null, 2) + '\n');
console.log(`[build-docs] escrito search-index.json (${searchIndex.length} entradas)`);

if (parityFailed) process.exitCode = 1;
