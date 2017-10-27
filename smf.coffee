###
smf - read Simple Machine Forum RSS feeds & mail the articles
      for SMF 2.0.x

Copyright 2011-2016 James Tittsler
@license MIT
###

# for each feed in database
#   fetch URL, category, lasttime
#   for each message in feed
#     if new
#       fetch message
#       mail message
#       record new last for feed

sqlite3 = require('sqlite3').verbose()
http = require 'http'
process = require 'process'
url = require 'url'
parser = require 'xml2json'
cheerio = require 'cheerio'
nodemailer = require 'nodemailer'
fs = require 'fs'
ini = require 'ini'
Log = require 'log'
log = new Log Log.DEBUG, fs.createWriteStream 'smf.log',
  flags: 'a'

config = ini.parse(fs.readFileSync('./smf.rc', 'utf-8'))
exports.config = config

cookie = config.smf.cookie

db = new sqlite3.Database config.database.database
smtpConfig = 
  host: config.email.host
  port: config.email.port
  ignoreTLS: true
if config.email.user
  smtpConfig.auth =
    user: config.email.user
    pass: config.email.pass
exports.mailer = nodemailer.createTransport(smtpConfig)

feeds = []
items = []
lastdate = new Date '1970-1-1'

decodeEntity = (m, p1) ->
  return String.fromCharCode(parseInt(p1, 10))

unHTMLEntities = (a) ->
  a = unescape a
  a = a.replace /&amp;&#35;/g, '&#'
  a = a.replace /&quot;/g, '"'
  a = a.replace /&apos;/g, "'"
  a = a.replace /&lt;/g, '<'
  a = a.replace /&gt;/g, '>'
  a = a.replace /&amp;/g, '&'
  a = a.replace /&#(\d+);/g, decodeEntity
  return a

mailFrom = (a) ->
  a = unescape a
  a = a.replace /\s/g, '_'
  a.replace /[^A-Za-z0-9._]/g, ''

isoDateString = (d) ->
  pad = (n) -> if n >= 10 then n else '0' + n

  d.getUTCFullYear() + '-' +
  pad(d.getUTCMonth()+1) + '-' +
  pad(d.getUTCDate()) + 'T' +
  pad(d.getUTCHours()) + ':' +
  pad(d.getUTCMinutes()) + ':' +
  pad(d.getUTCSeconds()) + 'Z'

processItems = () ->
  processPage = (page) ->
    $ = cheerio.load page
    # look through all the div.post_wrapper for one that contains
    # a subject for the desired message number
    $h5 = $("#subject_#{u.hash.replace('#msg', '')}")
    $el = $h5.closest('.post_wrapper')
    from = $el.find('div.poster a[title^="View the profile of"]').eq(0).text()
    $post = $el.find('div.post').eq(0)
    $('div.quote', $post).attr('style', 'color: #000; background-color: #d7daec; margin: 1px; padding: 6px; font-size: 1em; line-height: 1.5em; font-style: italic; font-family: Georgia, Times, serif;')
    $('div.quoteheader,div.codeheader', $post).attr('style', 'color: #000; text-decoration: none; font-style: normal; font-weight: bold; font-size: 1em; line-height: 1.2em; padding-bottom: 4px;')
    $('.meaction', $post).attr('style', 'color: red;')
    $('embed', $post).each (i) ->
      src = decodeURIComponent $(this).attr('src')
      log.debug "    embed: #{src}"
      $(this).replaceWith "<p><a href=\"#{src}\">#{src}</a></p>"
    post = $post.html()
    isodate = isoDateString(d)
    log.debug "From: #{from}"
    log.debug "Subject: [#{item.category}] #{unHTMLEntities(item.title)}"
    log.debug "Date: #{isodate} Lastdate: #{isoDateString(lastdate)}"
    exports.mailer.sendMail
      from: "\"#{from}\" #{exports.config.email.sender}"
      to: exports.config.email.to
      subject: "[#{item.category}] #{unHTMLEntities(item.title.trim())}"
      html: "<html><head></head><body><div><p><b>From:</b> #{from}<br /><b>Date:</b> #{item.pubDate}</p><div>#{post}</div><p><a href=\"#{item.link}\">Original message</a></p></div></body></html>"
      (error, success) ->
        if error
          log.debug ">>failed #{isodate}"
          log.debug error
          process.exit(1)
        else
          log.debug ">>sent #{isodate} for #{item.category}"
          st = db.prepare "UPDATE feeds SET last=(?) WHERE category=(?)"
          st.run isodate, item.category
          st.finalize () ->
            log.debug "db #{item.category} <- #{isodate}"
            process.nextTick processItems
            return

  if items.length is 0
    process.nextTick processFeeds
    return
  item = items.pop()

  d = new Date item.pubDate
  if d <= lastdate
    process.nextTick processItems
    return

  category = item.category.replace /&amp;&#35;/g, '&#'
  category = category.replace /&#(\d+);/g, decodeEntity
  item.category = category

  u = url.parse item.link
  log.debug "----- #{item.category}:#{item.title}: #{item.link}"
  headers =
    host: exports.config.smf.host
    cookie: cookie

  http.get {host: u.host, port: 80, path: u.pathname+u.search, headers: headers}, (res) ->
    page = ''
    res.on 'data', (chunk) ->
      page += chunk
    res.on 'end', () ->
      processPage page
    res.on 'error', (e) ->
      log.error "unable to fetch page #{item.link}: #{e.message}"

processRSS = (rss) ->
  # sanitize string, removing spurious control characters
  rss = rss.replace(/\x1f/g, '')
  try
    j = parser.toJson rss, object: true
    items = j.rss?.channel?.item
  catch error
    console.log "unable to parse RSS", rss
    items = []
  if items
    log.debug "*** #{items.length} items"
  else
    log.debug "*** No items array for #{rss}"
    items = []

  processItems()

processFeeds = () ->
  if feeds.length is 0
    db.close()
    return
  feed = feeds.shift()
  lastdate = new Date feed.last
  log.debug "= #{feed.category}  #{feed.last}"
  u = url.parse feed.url
  headers =
    host: exports.config.smf.host
    cookie: cookie
  http.get {host: u.host, port: 80, path: u.pathname+u.search, headers: headers}, (res) ->
    rss = ''
    res.on 'data', (chunk) ->
      rss += chunk
    res.on 'end', () ->
      processRSS rss
    res.on 'error', (e) ->
      console.log "unable to read"
      log.error "unable to read #{row.category}: #{e.message}"

db.all 'SELECT * FROM feeds', (err, rows) ->
  rows.forEach (row) ->
    feeds.push row
  log.debug '-'
  processFeeds()
