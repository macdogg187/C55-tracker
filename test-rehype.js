const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ReactMarkdown = require('react-markdown').default;
const rehypeSlug = require('rehype-slug').default;

const components = {
  h2: ({ id, children }) => createElement('h2', { id, className: 'my-h2' }, children)
};

const html = renderToStaticMarkup(
  createElement(ReactMarkdown, {
    rehypePlugins: [rehypeSlug],
    components: components,
    children: '## Hello World'
  })
);
console.log(html);
