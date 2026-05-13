"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Components } from "react-markdown";

function glossaryComponents(): Components {
  return {
    h1: ({ id, children }) => (
      <h1
        id={id}
        className="mb-6 scroll-mt-6 font-orbitron text-3xl font-bold tracking-tight text-[#f0dfc0]"
      >
        {children}
      </h1>
    ),
    h2: ({ id, children }) => (
      <h2
        id={id}
        className="mb-3 mt-10 scroll-mt-6 font-orbitron text-xl font-semibold uppercase tracking-wider text-[#e8a020] first:mt-0"
      >
        {children}
      </h2>
    ),
    h3: ({ id, children }) => (
      <h3
        id={id}
        className="mb-2 mt-6 scroll-mt-6 text-base font-semibold text-[#f0dfc0]"
      >
        {children}
      </h3>
    ),
    h4: ({ id, children }) => (
      <h4
        id={id}
        className="mb-1.5 mt-4 scroll-mt-6 font-orbitron text-sm font-semibold uppercase tracking-widest text-[#8a7a60]"
      >
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p className="mb-4 font-mono leading-relaxed text-[#8a7a60]">{children}</p>
    ),
    a: ({ href, children }) => {
      const isInternalHash = href?.startsWith("#");

      return (
        <a
          href={href}
          className="text-[#e8a020] underline underline-offset-2 hover:text-[#c85a10]"
          target={!isInternalHash && href?.startsWith("http") ? "_blank" : undefined}
          rel={!isInternalHash && href?.startsWith("http") ? "noopener noreferrer" : undefined}
          onClick={(e) => {
            if (isInternalHash) {
              const el = document.getElementById(href.slice(1));
              if (el) {
                e.preventDefault();
                el.scrollIntoView({ behavior: "smooth" });
                window.history.pushState(null, "", href);
              }
            }
          }}
        >
          {children}
        </a>
      );
    },
    ul: ({ children }) => (
      <ul className="mb-4 ml-5 list-disc space-y-1.5 font-mono text-[#8a7a60]">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-4 ml-5 list-decimal space-y-1.5 font-mono text-[#8a7a60]">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-4 border-[#c85a10]/60 bg-[#c85a10]/10 px-4 py-3 font-mono text-sm text-[#e8a020] [&>p]:mb-0">
        {children}
      </blockquote>
    ),
    code: ({ className, children, ...props }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return (
          <code
            className="block overflow-x-auto whitespace-pre border border-[#2e2820] bg-[#0e0c0a] p-4 font-mono text-sm leading-relaxed text-[#f0dfc0]"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          className="bg-[#2e2820] px-1.5 py-0.5 font-mono text-[0.8em] text-[#e8a020]"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="mb-4 mt-1 overflow-x-auto border border-[#2e2820] bg-[#0e0c0a]">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="mb-6 overflow-x-auto border border-[#2e2820]">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-[#1c1814] text-[#8a7a60]">{children}</thead>
    ),
    tbody: ({ children }) => (
      <tbody className="divide-y divide-[#2e2820]">{children}</tbody>
    ),
    tr: ({ children }) => (
      <tr className="transition-colors hover:bg-[#2e2820]/40">{children}</tr>
    ),
    th: ({ children }) => (
      <th className="px-4 py-2.5 text-left font-mono text-xs font-semibold uppercase tracking-wider text-[#4a3c28]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-2.5 font-mono text-[#8a7a60]">{children}</td>
    ),
    hr: () => <hr className="my-8 border-[#2e2820]" />,
    strong: ({ children }) => (
      <strong className="font-semibold text-[#f0dfc0]">{children}</strong>
    ),
    em: ({ children }) => <em className="italic text-[#8a7a60]">{children}</em>,
  };
}

export function GlossaryContent({ markdown }: { markdown: string }) {
  const components = glossaryComponents();

  return (
    <article>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
