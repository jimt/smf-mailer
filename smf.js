// @ts-check
/*
smf - read Simple Machine Forum RSS feeds & mail the articles
      for SMF 2.0.x

Copyright 2011-2021 James Tittsler
@license MIT
*/

// for each feed in database
//   fetch URL, category, lasttime
//   for each message in feed
//     if new
//       fetch message
//       mail message
//       record new last for feed

const sqlite3 = require('sqlite3');
const sqlite = require("sqlite");
const axios = require('axios').default;
const process = require("process");
const url = require("url");
const parser = require("xml2json");
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const fs = require("fs");
const os = require("os");
const ini = require("ini");
var config = ini.parse(fs.readFileSync("./smf.rc", "utf-8"));
let smtpConfig = {
  host: config.email.host,
  port: config.email.port,
  ignoreTLS: true
};
if (config.email.user) {
  smtpConfig.auth = {
    user: config.email.user,
    pass: config.email.pass
  };
}
let mailer = nodemailer.createTransport(smtpConfig);

const log4js = require("log4js");
log4js.configure({
  appenders: { smf: { type: 'file', filename: 'smf.log' } },
  categories: { default: { appenders: ['smf'], level: config.smf.loglevel } }
});
const log = log4js.getLogger('smf');

let feeds = [];
let items = [];
let lastdate = new Date("1970-1-1");

let decodeEntity = (m, p1) => String.fromCharCode(parseInt(p1, 10));

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {string} a
 */
function unHTMLEntities(a) {
  a = unescape(a);
  a = a.replace(/&amp;&#35;/g, "&#");
  a = a.replace(/&quot;/g, '"');
  a = a.replace(/&apos;/g, "'");
  a = a.replace(/&lt;/g, "<");
  a = a.replace(/&gt;/g, ">");
  a = a.replace(/&amp;/g, "&");
  a = a.replace(/&#(\d+);/g, decodeEntity);
  return a;
};

async function processPage(item, page) {
  let url = item.link;
  let msgid = url.replace(/.*#msg/, '');
  let $ = cheerio.load(page);
  // look through all the div.post_wrapper for one that contains
  // a subject for the desired message number
  let $h5 = $(`#subject_${msgid}`);
  let $el = $h5.closest(".post_wrapper");
  let from = $el
    .find('div.poster a[title^="View the profile of"]')
    .eq(0)
    .text();
  let $post = $el.find("div.post").eq(0);
  $("div.quote", $post).attr(
    "style",
    "color: #000; background-color: #d7daec; margin: 1px; padding: 6px; font-size: 1em; line-height: 1.5em; font-style: italic; font-family: Georgia, Times, serif;"
  );
  $("div.quoteheader,div.codeheader", $post).attr(
    "style",
    "color: #000; text-decoration: none; font-style: normal; font-weight: bold; font-size: 1em; line-height: 1.2em; padding-bottom: 4px;"
  );
  $(".meaction", $post).attr("style", "color: red;");
  $("embed", $post).each(function () {
    let src = decodeURIComponent($(this).attr("src"));
    log.debug(`    embed: ${src}`);
    return $(this).replaceWith(`<p><a href="${src}">${src}</a></p>`);
  });
  let $attachments = $el.find("div.attachments");
  if ($attachments) {
    $attachments.attr("style", "font-size: 0.8em;");
    $("a", $attachments)
      .prop("onclick", null);
    $post.append($attachments);
  }
  let post = $post.html();
  let d = new Date(item.pubDate);
  let isodate = d.toISOString();
  let originalLink = item.link;
  if (config.smf.protocol.startsWith('https')) {
    originalLink = originalLink.replace('http:', 'https:');
  }
  log.debug(`From: ${from}`);
  log.debug(`Subject: [${item.category}] ${unHTMLEntities(item.title)}`);
  log.debug(`Date: ${isodate} Lastdate: ${lastdate.toISOString()}`);
  mailer.sendMail(
    {
      from: `"${from}" ${config.email.sender}`,
      to: config.email.to,
      subject: `[${item.category}] ${unHTMLEntities(item.title.trim())}`,
      html: `<html><head></head><body><div><p><b>From:</b> ${from}<br /><b>Date:</b> ${item.pubDate
        }</p><div style="max-width:72ch;">${post}</div>
      <p><a href="${originalLink}">Original message</a></p></div></body></html>`
    },
    function (error) {
      if (error) {
        log.debug(`>>failed to send mail ${msgid}`);
        log.debug(error);
        process.exit(1);
      }
    });
  log.debug(`>>sent ${msgid} (${isodate}) for ${item.category}`);
  await config.db.run("UPDATE feeds SET last=(?) WHERE category=(?)",
    isodate, item.category);
}

/**
 * @param {string} category
 * @param {any} items
 */
async function processItems(category, items) {
  for (let item of items) {
    let d = new Date(item.pubDate);
    if (d <= lastdate) {
      continue;   // skip messages we have seen before
    }

    await sleep(config.smf.item_fetch_delay || 500);
    try {
      const res = await axios.get(item.link, {
        headers: {
          Cookie: config.smf.cookie
        }
      })
      processPage(item, res.data);
    } catch (error) {
      console.error(`processItem ${category} fetch error ${error}`);
      log.error(`processItem ${category} fetch error ${error}`);
      return;     // give up on category if there are problems fetching
    }
  }
}

/**
 * @param {string} category
 * @param {string} rss
 */
async function processRSS(category, rss) {
  let items = [];
  // sanitize string, removing spurious control characters
  rss = rss.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, "");
  rss = rss.replace(/<:br\s*\/></, "");   // bizzare special case of <:br /><
  try {
    let j = parser.toJson(rss, { object: true });
    // @ts-ignore
    if (j.rss && j.rss.channel && j.rss.channel.item) {
      // @ts-ignore
      items = j.rss.channel.item;
    }
  } catch (error) {
    console.error("unable to parse RSS at", category);
    log.error("unable to parse RSS at", category);
    fs.writeFileSync(`${os.tmpdir()}/failed.rss`, `#### ${new Date().toISOString()} ####\n`, { flag: 'a' });
    fs.writeFileSync(`${os.tmpdir()}/failed.rss`, rss, { flag: 'a' });
    return;
  }

  await processItems(category, items.reverse());
}

async function processFeed(feed) {
  lastdate = new Date(feed.last);
  log.debug(`= ${feed.category}  ${feed.last}`);
  await sleep(config.smf.feed_fetch_delay || 500);
  try {
    const res = await axios.get(feed.url, {
      headers: {
        Cookie: config.smf.cookie
      }
    })
    await processRSS(feed.category, res.data);
  } catch (error) {
    console.error(`processFeed ${feed.category} error ${error}`);
    log.error(`processFeed ${feed.category} error ${error}`);
    return;
  }
}

async function smf() {
  const db = await sqlite.open({
    filename: config.database.database,
    driver: sqlite3.Database
  });
  config.db = db;

  const rows = await db.all("SELECT * FROM feeds");
  for (const row of rows) {
    await processFeed(row);
  }
}

smf();
