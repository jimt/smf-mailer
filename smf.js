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

const ITEM_FETCH_DELAY = 1000;
const FEED_FETCH_DELAY = 5000;

let sqlite3 = require("sqlite3").verbose();
let http = require("http");
let https = require("https");
let process = require("process");
let url = require("url");
let parser = require("xml2json");
let cheerio = require("cheerio");
let nodemailer = require("nodemailer");
let fs = require("fs");
let os = require("os");
let ini = require("ini");
const log4js = require("log4js");
log4js.configure({
  appenders: { smf: { type: 'file', filename: 'smf.log' } },
  categories: { default: { appenders: ['smf'], level: 'error' } }
});
const log = log4js.getLogger('smf');

let config = ini.parse(fs.readFileSync("./smf.rc", "utf-8"));
let client = (config.smf.protocol.includes("https") ? https : http);
let { cookie } = config.smf;

let db = new sqlite3.Database(config.database.database);
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

async function processItems() {
  let processPage = function (page) {
    let $ = cheerio.load(page);
    // look through all the div.post_wrapper for one that contains
    // a subject for the desired message number
    let $h5 = $(`#subject_${u.hash.replace("#msg", "")}`);
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
    let isodate = d.toISOString();
    log.debug(`From: ${from}`);
    log.debug(`Subject: [${item.category}] ${unHTMLEntities(item.title)}`);
    log.debug(`Date: ${isodate} Lastdate: ${lastdate.toISOString()}`);
    return mailer.sendMail(
      {
        from: `"${from}" ${config.email.sender}`,
        to: config.email.to,
        subject: `[${item.category}] ${unHTMLEntities(item.title.trim())}`,
        html: `<html><head></head><body><div><p><b>From:</b> ${from}<br /><b>Date:</b> ${item.pubDate
          }</p><div style="max-width:72ch;">${post}</div>
        <p><a href="${item.link.replace('http:', 'https:')
          }">Original message</a></p></div></body></html>`
      },
      function (error) {
        if (error) {
          log.debug(`>>failed ${isodate}`);
          log.debug(error);
          return process.exit(1);
        } else {
          log.debug(`>>sent ${isodate} for ${item.category}`);
          let st = db.prepare("UPDATE feeds SET last=(?) WHERE category=(?)");
          st.run(isodate, item.category);
          return st.finalize(function () {
            log.debug(`db ${item.category} <- ${isodate}`);
            process.nextTick(processItems);
          });
        }
      }
    );
  };

  if (items.length === 0) {
    process.nextTick(processFeeds);
    return;
  }
  var item = items.pop();

  var d = new Date(item.pubDate);
  if (d <= lastdate) {
    process.nextTick(processItems);
    return;
  }

  let category = item.category.replace(/&amp;&#35;/g, "&#");
  category = category.replace(/&#(\d+);/g, decodeEntity);
  item.category = category;

  var u = url.parse(item.link);
  log.debug(`----- ${item.category}:${item.title}: ${item.link}`);
  let headers = {
    host: config.smf.host,
    cookie
  };

  await sleep(ITEM_FETCH_DELAY);
  client.get(
    {
      host: u.host,
      port: u.port,
      path: u.pathname + u.search,
      headers
    },
    function (res) {
      if (res.statusCode != 200) {
        console.error(`error ${res.statusCode} ${item.category}:${item.title}: ${item.link}`);
        log.error(`error ${res.statusCode} ${item.category}:${item.title}: ${item.link}`);
        return;
      }
      let page = "";
      res.on("data", chunk => (page += chunk));
      res.on("end", () => processPage(page));
      res.on("error", e =>
        log.error(`unable to fetch page ${item.link}: ${e.message}`)
      );
    }
  );
};

/**
 * @param {string} feedurl
 * @param {string} rss
 */
function processRSS(feedurl, rss) {
  // sanitize string, removing spurious control characters
  rss = rss.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, "");
  rss = rss.replace(/<:br\s*\/></, "");   // bizzare special case of <:br /><
  items = [];
  try {
    let j = parser.toJson(rss, { object: true });
    // @ts-ignore
    if (j.rss && j.rss.channel && j.rss.channel.item) {
      // @ts-ignore
      items = j.rss.channel.item;
    }
  } catch (error) {
    console.error("unable to parse RSS at", feedurl);
    log.error("unable to parse RSS at", feedurl);
    fs.writeFileSync(`${os.tmpdir()}/failed.rss`, `#### ${new Date().toISOString()} ####\n`, { flag: 'a' });
    fs.writeFileSync(`${os.tmpdir()}/failed.rss`, rss, { flag: 'a' });
  }
  log.debug(`*** ${items.length} items for {rss}`);

  return processItems();
};

async function processFeeds() {
  if (feeds.length === 0) {
    db.close();
    return;
  }
  let feed = feeds.shift();
  lastdate = new Date(feed.last);
  log.debug(`= ${feed.category}  ${feed.last}`);
  let u = url.parse(feed.url);
  let headers = {
    host: config.smf.host,
    cookie
  };
  await sleep(FEED_FETCH_DELAY);
  client.get(
    {
      protocol: u.protocol,
      host: u.host,
      port: u.port,
      path: u.pathname + u.search,
      headers
    },
    function (res) {
      if (res.statusCode != 200) {
        console.error(`error ${res.statusCode} category ${feed.category}`);
        log.error(`error ${res.statusCode} category ${feed.category}`);
        process.nextTick(processFeeds);
        return;
      }

      let rss = "";
      res.on("data", chunk => (rss += chunk));
      res.on("end", () => processRSS(feed.url, rss));
      res.on("error", function (e) {
        console.error("unable to read feed");
        log.error(`unable to read ${feed.category}: ${e.message}`);
      });
    }
  );
};

db.all("SELECT * FROM feeds", function (err, rows) {
  rows.forEach(row => feeds.push(row));
  log.debug("-");
  return processFeeds();
});
