import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import fs from 'fs';
import { GlossaryContent } from './app/glossary/GlossaryContent';

const md = fs.readFileSync('docs/GLOSSARY.md', 'utf-8');
const html = renderToStaticMarkup(createElement(GlossaryContent, { markdown: md }));
console.log(html);
