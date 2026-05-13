const fs = require('fs');

function textFromNode(node) {
  // simple mock
  return node;
}

function githubHeadingBaseId(children) {
  return textFromNode(children)
    .trim()
    .toLowerCase()
    .replace(/\s/g, "-")
    .replace(/[^\w-]/g, "");
}

const md = fs.readFileSync('docs/GLOSSARY.md', 'utf-8');

const headings = [];
const links = [];

const lines = md.split('\n');
for (const line of lines) {
  const matchHeading = line.match(/^##\s+(.*)/);
  if (matchHeading) {
    headings.push(githubHeadingBaseId(matchHeading[1]));
  }
  
  const matchLink = line.match(/\[([^\]]+)\]\(\#([^\)]+)\)/);
  if (matchLink) {
    links.push(matchLink[2]);
  }
}

for (const link of links) {
  if (!headings.includes(link)) {
    console.log("BROKEN LINK:", link);
  }
}
