// @ts-check
/*
smf - read Simple Machine Forum Recent Posts & mail the articles
      for SMF 2.1.x

Copyright 2011-2022 James Tittsler
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
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const fs = require("fs");
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
 * @returns {number} highwater
 */
function getHighWaterMark() {
  let highwater;
  try {
    highwater = parseInt(fs.readFileSync(config.smf.highwatermark, 'utf-8'), 10);
  } catch (err) {
    console.error(`unable to read high water mark from ${config.smf.highwatermark}`);
    log.error(`unable to read high water mark from ${config.smf.highwatermark}`);
    process.exit(1);
  }

  if (isNaN(highwater) || highwater == 0) {
    console.error('high water mark not set');
    log.error('high water mark not set');
    process.exit(1);
  }
  return highwater;
}

/**
 * @param {number} highwater
 */
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
 * @returns {string} a
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

/**
 * @returns {Promise<number>}
 */
async function processPage(highwater, page, posts) {
  let $ = cheerio.load(page);
  let more = 0;
  $('div.windowbg').each(function (i) {
    let msg = {};
    let $h5as = $(this).find('.topic_details>h5').first().find('a');
    msg.board = $h5as.eq(0).attr('href');
    msg.category = $h5as.eq(0).text();
    msg.link = $h5as.eq(1).attr('href');
    msg.subject = unHTMLEntities($h5as.eq(1).attr('title').trim());
    msg.id = msg.link.replace(/.*#msg/, '');
    if (msg.id > highwater) {
      let $authDate = $(this).find('.topic_details .smalltext').first();
      msg.author = $authDate.find('a').first().text();
      let dtrego = /.*\s-\s(\S+)(,|\sat)\s(\d\d:\d\d:\d\d).*/.exec($authDate.text());
      if (dtrego[1] === 'Today') {
        // FIXME: there is some ambiguity in "Today"
        let d = new Date();
        msg.pubDate = d.toISOString().slice(0, 11) + dtrego[3];
      } else {
        msg.pubDate = dtrego[1] + 'T' + dtrego[3];
      }
      let $post = $(this).find('.list_posts').first();
      $("blockquote", $post).contents().unwrap().wrap('<div class="quote" />');
      $("div.quote", $post).attr(
        "style",
        "color: #000; background-color: #d7daec; margin: 1px; padding: 6px; font-size: 1em; line-height: 1.5em; font-style: italic; font-family: Georgia, Times, serif;"
      );
      $("cite", $post).contents().unwrap().wrap('<div class="quoteheader" />');
      $("div.quoteheader", $post).attr(
        "style",
        "color: #000; text-decoration: none; font-style: normal; font-weight: bold; font-size: 1em; line-height: 1.2em; padding-bottom: 4px;"
      );
      $(".meaction", $post).attr("style", "color: red;");
      msg.post = $post.html();
      posts.unshift(msg);
      more += 1;
    } else {
      more = 0;
    }
  });
  return more;
}

async function smf() {
  let highwater = getHighWaterMark();
  const origmark = highwater;
  let more = 10;
  let start = 0;
  let posts = [];
  let res;

  // process Recent Posts pages until we get to messages we've seen
  while (more > 0) {
    try {
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
    // more: integer increment to "start", if 0 high water mark exceeded
    // posts: an array of post objects
    more = await processPage(highwater, res.data, posts);
    start += more;

    if (more) {
      await sleep(config.smf.recent_fetch_delay || 5000);
    }
  }

  for (let msg of posts) {
    mailer.sendMail({
      from: `"${msg.author}" ${config.email.sender}`,
      to: config.email.to,
      subject: `[${msg.category}] ${msg.subject}`,
      html: `<html><head></head><body>
        <div><p><b>From:</b> ${msg.author}<br />
                <b>Date:</b> ${msg.pubDate} #${msg.id}</p>
          <div style="max-width:72ch;">${msg.post}</div>
          <p><a href="${msg.link}">Original message</a></p>
        </div></body></html>`
    },
      function (error) {
        if (error) {
          log.error(`>>failed to send mail ${msg.id}`);
          log.error(error);
          process.exit(42);
        }
      }
    );
    if (msg.id > highwater) {
      highwater = msg.id;
    }
    await sleep(config.smf.email_delay || 5000);
  }

  if (highwater > origmark) {
    setHighWaterMark(highwater);
  }
}

smf();
