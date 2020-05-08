/*
 * check parsing of a (corrupt?) XML file
 *
 */

const fs = require('fs');
const parser = require("xml2json");

var json;
let xml = fs.readFileSync("/tmp/test.rss");

try {
    json = parser.toJson(xml);
} catch (error) {
    console.error(error);
    process.exit(1);
}

console.log(json);
