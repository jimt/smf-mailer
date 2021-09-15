# smf

This is a simple JavaScript
[Node.js](https://nodejs.org/en/) program
that is intended to be run periodically (cron)
to monitor the **Recent Posts** page(s) of a
[Simple Machines Forum](http://www.simplemachines.org/)
(SMF) and email all new articles discovered.

## History

This was originally written in
[CoffeeScript](http://coffeescript.org/) but
has been
[Decaffeinated](http://decaffeinate-project.org/)
to modern JavaScript. And then later converted
to use async/await. It checked the RSS feeds
for new messages, but from Version 4 it was
rewritten to use the **Recent Posts** page(s).

The trade-off between the two methods is that
**Recent Posts** gives you the messages in one
or two page fetches, but there is no indication
of message attachments.  The RSS feed method
allows complete message and attachment access,
but at the expense of more http round-trips and
server load (which caused problems with HostPapa
hosting).

## License

MIT

