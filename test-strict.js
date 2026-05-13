const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
// React DOM Server doesn't do strict mode double renders.
