/*
smf - read Simple Machine Forum RSS feeds & mail the articles
      for SMF 2.0.x

Copyright 2011-2018 James Tittsler
@license MIT
*/

// for each feed in database
//   fetch URL, category, lasttime
//   for each message in feed
//     if new
//       fetch message
//       mail message
//       record new last for feed

let sqlite3 = require("sqlite3").verbose();
let http = require("http");
let process = require("process");
let url = require("url");
let parser = require("xml2json");
let cheerio = require("cheerio");
let nodemailer = require("nodemailer");
let fs = require("fs");
let ini = require("ini");
let Log = require("log");
let log = new Log(Log.DEBUG, fs.createWriteStream("smf.log", { flags: "a" }));

let config = ini.parse(fs.readFileSync("./smf.rc", "utf-8"));
exports.config = config;

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
exports.mailer = nodemailer.createTransport(smtpConfig);

let feeds = [];
let items = [];
let lastdate = new Date("1970-1-1");

let decodeEntity = (m, p1) => String.fromCharCode(parseInt(p1, 10));

let unHTMLEntities = function(a) {
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

let isoDateString = function(d) {
  let pad = function(n) {
    return n >= 10 ? n : `0${n}`;
  };

  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds()) +
    "Z"
  );
};

var processItems = function() {
  let processPage = function(page) {
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
    $("embed", $post).each(function() {
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
    let isodate = isoDateString(d);
    log.debug(`From: ${from}`);
    log.debug(`Subject: [${item.category}] ${unHTMLEntities(item.title)}`);
    log.debug(`Date: ${isodate} Lastdate: ${isoDateString(lastdate)}`);
    return exports.mailer.sendMail(
      {
        from: `"${from}" ${exports.config.email.sender}`,
        to: exports.config.email.to,
        subject: `[${item.category}] ${unHTMLEntities(item.title.trim())}`,
        html: `<html><head></head><body><div><p><b>From:</b> ${from}<br /><b>Date:</b> ${
          item.pubDate
        }</p><div>${post}</div><p><a href="${
          item.link
        }">Original message</a></p></div></body></html>`
      },
      function(error) {
        if (error) {
          log.debug(`>>failed ${isodate}`);
          log.debug(error);
          return process.exit(1);
        } else {
          log.debug(`>>sent ${isodate} for ${item.category}`);
          let st = db.prepare("UPDATE feeds SET last=(?) WHERE category=(?)");
          st.run(isodate, item.category);
          return st.finalize(function() {
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
    host: exports.config.smf.host,
    cookie
  };

  return http.get(
    {
      protocol: u.protocol,
      host: u.host,
      port: u.port,
      path: u.pathname + u.search,
      headers
    },
    function(res) {
      let page = "";
      res.on("data", chunk => (page += chunk));
      res.on("end", () => processPage(page));
      return res.on("error", e =>
        log.error(`unable to fetch page ${item.link}: ${e.message}`)
      );
    }
  );
};

let processRSS = function(rss) {
  // sanitize string, removing spurious control characters
  rss = rss.replace(/\x1f/g, "");
  items = [];
  try {
    let j = parser.toJson(rss, { object: true });
    if (j.rss && j.rss.channel && j.rss.channel.item) {
      items = j.rss.channel.item;
    }
  } catch (error) {
    console.log("unable to parse RSS", rss);
  }
  log.debug(`*** ${items.length} items for {rss}`);

  return processItems();
};

var processFeeds = function() {
  if (feeds.length === 0) {
    db.close();
    return;
  }
  let feed = feeds.shift();
  lastdate = new Date(feed.last);
  log.debug(`= ${feed.category}  ${feed.last}`);
  let u = url.parse(feed.url);
  let headers = {
    host: exports.config.smf.host,
    cookie
  };
  return http.get(
    {
      protocol: u.protocol,
      host: u.host,
      port: u.port,
      path: u.pathname + u.search,
      headers
    },
    function(res) {
      let rss = "";
      res.on("data", chunk => (rss += chunk));
      res.on("end", () => processRSS(rss));
      return res.on("error", function(e) {
        console.log("unable to read");
        return log.error(`unable to read ${feed.category}: ${e.message}`);
      });
    }
  );
};

db.all("SELECT * FROM feeds", function(err, rows) {
  rows.forEach(row => feeds.push(row));
  log.debug("-");
  return processFeeds();
});