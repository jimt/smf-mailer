// @ts-check
/*
smf - read Simple Machine Forum Recent Posts & mail the articles
      for SMF 2.0.x

Copyright 2011-2021 James Tittsler
@license MIT
*/

// get message high water mark
// for each message on paginated Recent Posts page(s)
//   if message in board of interest
//     format mail message and push on stack
// record high water mark
// for each message on stack
//    pop and email
//    delay

const axios = require('axios').default;
const process = require("process");
const url = require("url");
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

function getHighWaterMark() {
  let highwater;
  try {
    highwater = parseInt(fs.readFileSync(config.smf.highwatermark, 'utf-8'), 10);
  } catch (err) {
    console.error(`unable to read high water mark from ${config.smf.highwatermark}`);
    log.error(`unable to read high water mark from ${config.smf.highwatermark}`);
    process.exit(1);
  }

  console.log(`high water mark ${highwater}`);
  if (isNaN(highwater) || highwater == 0) {
    console.error('high water mark not set');
    log.error('high water mark not set');
    process.exit(1);
  }
  return highwater;
}

function setHighWaterMark(highwater) {
  const highwaters = highwater + "";
  try {
    fs.writeFileSync(config.smf.highwatermark, highwaters);
  } catch (error) {
    console.error(`Unable to write high water mark to ${config.highwatermark}`);
    log.error(`Unable to write high water mark to ${config.highwatermark}`);
    process.exit(4);
  }
  return true;
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
 * @returns {Promise<number>}
 */
async function processPage(highwater, page, posts) {
  let $ = cheerio.load(page);
  $('.core_posts').each(function (i) {
    let msg = {};
    let $h5as = $(this).find('.topic_details>h5').first().find('a');
    msg.board = $h5as.eq(0).attr('href');
    msg.category = $h5as.eq(0).text();
    msg.msgLink = $h5as.eq(1).attr('href');
    msg.subject = unHTMLEntities($h5as.eq(1).text());
    msg.msgid = msg.msgLink.replace(/.*#msg/, '');
    if (msg.msgid > highwater) {
      let $authDate = $(this).find('.topic_details .smalltext').first();
      msg.author = $authDate.find('a').first().text();
      let dtrego = /.*\son\s(\S+)(,|\sat)\s(\d\d:\d\d:\d\d).*/.exec($authDate.text());
      if (dtrego[1] === 'Today') {
        // FIXME: there is some ambiguity in "Today"
        let d = new Date();
        msg.dt = d.toISOString().slice(0, 11) + dtrego[3];
      } else {
        msg.dt = dtrego[1] + 'T' + dtrego[3];
      }
      let $post = $(this).find('.list_posts').first();
      $("div.quote", $post).attr(
        "style",
        "color: #000; background-color: #d7daec; margin: 1px; padding: 6px; font-size: 1em; line-height: 1.5em; font-style: italic; font-family: Georgia, Times, serif;"
      );
      $("div.quoteheader,div.codeheader", $post).attr(
        "style",
        "color: #000; text-decoration: none; font-style: normal; font-weight: bold; font-size: 1em; line-height: 1.2em; padding-bottom: 4px;"
      );
      $(".meaction", $post).attr("style", "color: red;");
      msg.post = $post.html();
      console.log('------------');
      console.dir(msg);
      posts.push(msg);
    }
  });
  return 0;
}

async function smf() {
  let highwater = getHighWaterMark();
  const origmark = highwater;
  let more = 10;
  let start = 0;
  let posts = [];
  let res;

  console.log(`smf() highwater=${highwater}`);
  // process Recent Posts pages until we get to messages we've seen
  while (more > 0) {
    try {
      console.log(`fetching ${config.smf.recent_url}${start}`);
      log.debug(`fetching ${config.smf.recent_url}${start}`);
      res = await axios.get(config.smf.recent_url + start, {
        headers: {
          Cookie: config.smf.cookie
        }
      });
    } catch (error) {
      console.error(`Unable to fetch recent: ${config.smf.recent_url}${start} error ${error}`);
      log.error(`Unable to fetch recent: ${config.smf.recent_url}${start} error ${error}`);
      process.exit(2);
    }
    // process a page of recent posts
    // returning
    // more: integer increment to start, if 0 high water mark exceeded
    // posts: an array of post objects
    more = await processPage(highwater, res.data, posts);
    start += more;

    console.log('delay');
    await sleep(config.smf.recent_fetch_delay || 5000);
  }

  if (highwater > origmark) {
    console.log(`setting highwater ${highwater}`);
    setHighWaterMark(highwater);
  }
}

smf();
