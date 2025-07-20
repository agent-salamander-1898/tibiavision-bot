/*
 * Discord bot implementation for TibiaWiki content.
 *
 * This script creates a bot named "tibiavision" which registers two slash
 * commands: `/look` and `/creature`.  The `/look` command accepts the
 * name of an item and returns a description similar to the green "You see …"
 * text shown on the Tibia Wiki along with the item's thumbnail.  The
 * `/creature` command accepts the name of a creature and returns its
 * hitpoints, experience, elemental weaknesses/strengths, and a thumbnail.
 *
 * Data for creatures is retrieved from the open source TibiaWikiApi
 * (https://tibiawiki.dev/api/creatures/{name}) which exposes structured
 * JSON for many wiki entities.  Item descriptions are constructed by
 * parsing the wikitext infobox of the corresponding page on
 * https://tibia.fandom.com using MediaWiki's action=parse endpoint.  The
 * bot also scrapes the rendered page for the OpenGraph image via a simple
 * regular expression.
 *
 * To run this bot you need Node.js ≥18 (for native fetch) and the
 * discord.js library installed.  Replace the placeholders for
 * DISCORD_BOT_TOKEN, CLIENT_ID and optionally GUILD_ID with your bot's
 * configuration.  When first run the bot will register its slash
 * commands globally; if you want to test in a single guild supply a
 * GUILD_ID to register locally instead.
 */

const { Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder, SlashCommandBuilder } = require('discord.js');

// --- Begin configuration section ---
// Insert your bot token and application client ID below.  Never commit
// real tokens to source control.
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'YOUR_DISCORD_BOT_TOKEN';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID';
// Optional: restrict slash command registration to a single guild during
// development.  Leave undefined or empty to register globally.
const GUILD_ID = process.env.DISCORD_GUILD_ID || undefined;
// --- End configuration section ---

// Helper: fetch JSON with graceful error handling.  Uses the global
// fetch available in Node.js >=18.  If any network or JSON error occurs
// the promise will reject.
async function fetchJson(url) {
  const res = await fetch(url, {
    // Provide a user agent string so fandom returns HTML instead of JSON when
    // scraping pages.  Without a UA some endpoints return alternate
    // representations.
    headers: { 'User-Agent': 'Mozilla/5.0 (TibiaVision Bot)' }
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return json;
}

/**
 * Retrieve item information from Tibia Fandom.
 *
 * This function performs two requests: one to the MediaWiki API to get the
 * wikitext of the infobox and extract structured fields, and another to the
 * rendered HTML page to obtain the OpenGraph thumbnail.  From the
 * extracted fields we reconstruct the familiar "You see …" description.
 *
 * @param {string} name Original name of the item as entered by the user.
 * @returns {Promise<{look: string, image: string, title: string}>}
 */
async function getItemInfo(name) {
  // Normalise the page title: replace spaces with underscores for API
  // requests.  Fandom page titles are case sensitive after the first
  // letter, so we leave the original casing in place.
  const pageTitle = name.replace(/ /g, '_');
  const apiUrl = `https://tibia.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json&formatversion=2`;
  const apiData = await fetchJson(apiUrl);
  if (!apiData || !apiData.parse || !apiData.parse.wikitext) {
    throw new Error('Failed to retrieve wikitext for item');
  }
  const wikitext = apiData.parse.wikitext;
  // The infobox template consists of lines beginning with a pipe and a key.
  // Split on newlines and build a map of key/value pairs.  Keys are
  // normalised to lower case for easier lookup.
  const info = {};
  for (const line of wikitext.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([^=]+?)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();
      info[key] = value;
    }
  }
  // Extract relevant fields with sensible fallbacks.  Many item pages
  // specify values in varying capitalisation or may omit optional keys.
  const article = info['article'] || (info['actualname'] && /^[aeiou]/i.test(info['actualname']) ? 'an' : 'a');
  const actualName = info['actualname'] || name;
  const armor = info['armor'];
  const attrib = info['attrib'];
  const resist = info['resist'];
  const imbueSlots = parseInt(info['imbueslots'] || info['imbuing slots'] || '0', 10);
  const upgradeClass = info['upgradeclass'] || info['upgrade'] || '';
  const tier = info['tier'] || '0';
  const vocationRequired = info['vocationrequired'] || info['vocrequired'] || info['required vocation'] || '';
  const levelRequired = info['levelrequired'] || info['level req'] || '';
  const weight = info['weight'] ? info['weight'].replace(/\s*oz\.?/i, '').trim() : '';
  // Build the "You see" description.  Comma‑separate only the parts that
  // actually exist to avoid trailing commas.
  const parts = [];
  if (armor) parts.push(`Arm:${armor}`);
  if (attrib) parts.push(attrib);
  if (resist) parts.push(`protection ${resist}`);
  let look = `You see ${article} ${actualName.toLowerCase()} (` + parts.join(', ') + ').';
  // Imbuements: if there are no imbuement slots we'll still include the
  // section but say "No imbuement slots".  Otherwise list empty slots.
  if (imbueSlots > 0) {
    look += `\nImbuements: ${'(Empty Slot)'.repeat(imbueSlots)}`;
  } else {
    look += '\nImbuements: None';
  }
  if (upgradeClass) {
    look += `\nClassification: ${upgradeClass}`;
  }
  look += ` Tier: ${tier}.`;
  if (vocationRequired) {
    look += `\nIt can only be wielded properly by ${vocationRequired} of level ${levelRequired || '?'} or higher.`;
  } else if (levelRequired) {
    look += `\nIt requires level ${levelRequired} or higher.`;
  }
  if (weight) {
    look += `\nIt weighs ${weight} oz.`;
  }
  // Fetch the HTML page to get the OpenGraph image.  We set a user agent
  // to avoid Fandom returning API JSON instead of HTML.  Fallback to
  // undefined if the meta tag is missing.
  const htmlRes = await fetch(`https://tibia.fandom.com/wiki/${encodeURIComponent(pageTitle)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (TibiaVision Bot)' } });
  const html = await htmlRes.text();
  let image = undefined;
  const metaMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (metaMatch) {
    image = metaMatch[1];
  }
  return { look, image, title: actualName };
}

/**
 * Retrieve creature information from TibiaWikiApi and Fandom.
 *
 * This function queries the TibiaWikiApi for a creature's numerical
 * attributes and damage modifiers.  It then determines which elements the
 * creature is weak or strong against based on the percentage values.  The
 * function also scrapes the Fandom page for a thumbnail image using the
 * OpenGraph metadata.  If the API does not return a creature the promise
 * rejects.
 *
 * @param {string} name Creature name from the user.
 * @returns {Promise<{description: string, image: string, title: string}>}
 */
async function getCreatureInfo(name) {
  const slug = name.replace(/ /g, '%20');
  const apiUrl = `https://tibiawiki.dev/api/creatures/${slug.toLowerCase()}`;
  const creature = await fetchJson(apiUrl);
  if (!creature || typeof creature !== 'object' || !creature.hp) {
    throw new Error('Creature not found');
  }
  // Basic properties
  const hp = creature.hp;
  const exp = creature.exp;
  // Damage modifiers: convert strings like "110%" into numbers for
  // comparison, ignoring percentage signs.
  const dmgMods = {
    physical: creature.physicalDmgMod,
    fire: creature.fireDmgMod,
    ice: creature.iceDmgMod,
    energy: creature.energyDmgMod,
    earth: creature.earthDmgMod,
    holy: creature.holyDmgMod,
    death: creature.deathDmgMod,
    drown: creature.drownDmgMod,
    hpdraindmg: creature.hpDrainDmgMod,
  };
  const weaknesses = [];
  const strengths = [];
  for (const [element, mod] of Object.entries(dmgMods)) {
    if (mod === undefined) continue;
    const numeric = parseFloat(String(mod).replace(/[^0-9\.]/g, ''));
    if (Number.isNaN(numeric)) continue;
    if (numeric > 100) {
      weaknesses.push(`${element} (${mod})`);
    } else if (numeric < 100) {
      strengths.push(`${element} (${mod})`);
    }
  }
  // Fetch the Fandom page for an image.  Some creature pages include
  // subpages or disambiguation; using underscores is usually sufficient.
  const pageTitle = name.replace(/ /g, '_');
  const htmlRes = await fetch(`https://tibia.fandom.com/wiki/${encodeURIComponent(pageTitle)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (TibiaVision Bot)' } });
  const html = await htmlRes.text();
  let image = undefined;
  const metaMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (metaMatch) {
    image = metaMatch[1];
  }
  // Construct a description summarising the creature.  We separate
  // weaknesses and strengths into comma‑delimited lists.  If a list is
  // empty we note that the creature has no notable resistances or
  // vulnerabilities.
  let description = `Hit Points: ${hp}\nExperience: ${exp}`;
  description += `\nWeak against: ${weaknesses.length ? weaknesses.join(', ') : 'none'}`;
  description += `\nStrong against: ${strengths.length ? strengths.join(', ') : 'none'}`;
  return { description, image, title: creature.actualname || creature.name || name };
}

/**
 * Register slash commands with Discord using the REST API.  If GUILD_ID is
 * defined then commands are registered for that guild only; otherwise
 * registration happens globally which may take up to an hour to update.
 */
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('look')
      .setDescription('Get the description of a Tibia item')
      .addStringOption(option => option
        .setName('name')
        .setDescription('Name of the item to look up')
        .setRequired(true)),
    new SlashCommandBuilder()
      .setName('creature')
      .setDescription('Get information about a Tibia creature')
      .addStringOption(option => option
        .setName('name')
        .setDescription('Name of the creature to look up')
        .setRequired(true)),
  ].map(cmd => cmd.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Registered commands for guild ' + GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered global commands');
  }
}

// Create the Discord client.  Only the Guilds intent is required for
// slash‑commands; no message intents are needed.  We also enable a
// handful of partials to guard against incomplete data structures.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.options.getString('name');
  if (interaction.commandName === 'look') {
    await interaction.deferReply();
    try {
      const { look, image, title } = await getItemInfo(name);
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(look)
        .setColor(0x3a8dff);
      if (image) embed.setThumbnail(image);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Unable to find information for that item.');
    }
  }
  if (interaction.commandName === 'creature') {
    await interaction.deferReply();
    try {
      const { description, image, title } = await getCreatureInfo(name);
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0x58b368);
      if (image) embed.setThumbnail(image);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Unable to find information for that creature.');
    }
  }
});

// Immediately register commands and log in.  Command registration is
// idempotent; repeated calls update existing definitions.
registerCommands().catch(err => console.error(err));
client.login(DISCORD_BOT_TOKEN).catch(err => console.error(err));