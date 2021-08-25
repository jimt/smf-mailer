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

## License

MIT

