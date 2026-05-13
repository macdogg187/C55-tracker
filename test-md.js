"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// test-md.ts
var import_react2 = require("react");
var import_server = require("react-dom/server");
var import_fs = __toESM(require("fs"));

// app/glossary/GlossaryContent.tsx
var import_react = require("react");
var import_react_markdown = __toESM(require("react-markdown"));
var import_remark_gfm = __toESM(require("remark-gfm"));
var import_jsx_runtime = require("react/jsx-runtime");
function textFromNode(node) {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromNode).join("");
  }
  if ((0, import_react.isValidElement)(node)) {
    return textFromNode(node.props.children);
  }
  return "";
}
function githubHeadingBaseId(children) {
  return textFromNode(children).trim().toLowerCase().replace(/\s/g, "-").replace(/[^\w-]/g, "");
}
function glossaryComponents() {
  const usedHeadingIds = /* @__PURE__ */ new Map();
  const headingId = (children) => {
    const baseId = githubHeadingBaseId(children);
    const count = usedHeadingIds.get(baseId) ?? 0;
    usedHeadingIds.set(baseId, count + 1);
    return count === 0 ? baseId : `${baseId}-${count}`;
  };
  return {
    h1: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "h1",
      {
        id: headingId(children),
        className: "mb-6 scroll-mt-6 text-3xl font-bold tracking-tight text-zinc-100",
        children
      }
    ),
    h2: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "h2",
      {
        id: headingId(children),
        className: "mb-3 mt-10 scroll-mt-6 text-xl font-semibold text-cyan-300 first:mt-0",
        children
      }
    ),
    h3: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "h3",
      {
        id: headingId(children),
        className: "mb-2 mt-6 scroll-mt-6 text-base font-semibold text-zinc-200",
        children
      }
    ),
    h4: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "h4",
      {
        id: headingId(children),
        className: "mb-1.5 mt-4 scroll-mt-6 text-sm font-semibold uppercase tracking-widest text-zinc-400",
        children
      }
    ),
    p: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "mb-4 leading-relaxed text-zinc-300", children }),
    a: ({ href, children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "a",
      {
        href,
        className: "text-cyan-400 underline underline-offset-2 hover:text-cyan-300",
        target: href?.startsWith("http") ? "_blank" : void 0,
        rel: href?.startsWith("http") ? "noopener noreferrer" : void 0,
        children
      }
    ),
    ul: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "mb-4 ml-5 list-disc space-y-1.5 text-zinc-300", children }),
    ol: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { className: "mb-4 ml-5 list-decimal space-y-1.5 text-zinc-300", children }),
    li: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "leading-relaxed", children }),
    blockquote: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("blockquote", { className: "my-4 border-l-4 border-amber-600/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200 [&>p]:mb-0", children }),
    code: ({ className, children, ...props }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "code",
          {
            className: "block overflow-x-auto whitespace-pre rounded-lg border border-zinc-700 bg-zinc-900 p-4 font-mono text-sm leading-relaxed text-zinc-200",
            ...props,
            children
          }
        );
      }
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "code",
        {
          className: "rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[0.8em] text-cyan-300",
          ...props,
          children
        }
      );
    },
    pre: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "mb-4 mt-1 overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-900", children }),
    table: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mb-6 overflow-x-auto rounded-lg border border-zinc-700", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("table", { className: "w-full border-collapse text-sm", children }) }),
    thead: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { className: "bg-zinc-800/80 text-zinc-300", children }),
    tbody: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { className: "divide-y divide-zinc-800", children }),
    tr: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { className: "transition-colors hover:bg-zinc-800/40", children }),
    th: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { className: "px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400", children }),
    td: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "px-4 py-2.5 text-zinc-300", children }),
    hr: () => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("hr", { className: "my-8 border-zinc-800" }),
    strong: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: "font-semibold text-zinc-100", children }),
    em: ({ children }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "italic text-zinc-300", children })
  };
}
function GlossaryContent({ markdown }) {
  const components = glossaryComponents();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("article", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_markdown.default, { remarkPlugins: [import_remark_gfm.default], components, children: markdown }) });
}

// test-md.ts
var md = import_fs.default.readFileSync("docs/GLOSSARY.md", "utf-8");
var html = (0, import_server.renderToStaticMarkup)((0, import_react2.createElement)(GlossaryContent, { markdown: md }));
console.log(html);
