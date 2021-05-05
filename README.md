# smf

This is a simple JavaScript
[Node.js](https://nodejs.org/en/) program
that is intended to be run periodically (cron)
to monitor the RSS feeds of a [Simple Machines
Forum](http://www.simplemachines.org/) (SMF)
and email all new articles discovered. A local
SQLite database is used to track which forums
to follow and their high-water marks.

It was originally written in
[CoffeeScript](http://coffeescript.org/) but
has been
[Decaffeinated](http://decaffeinate-project.org/)
to modern JavaScript. And then later converted
to use async/await.

## License

MIT

