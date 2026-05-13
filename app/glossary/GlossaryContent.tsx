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
        className="mb-6 scroll-mt-6 font-barlow text-3xl font-bold tracking-tight text-[#1A1A16]"
      >
        {children}
      </h1>
    ),
    h2: ({ id, children }) => (
      <h2
        id={id}
        className="mb-3 mt-10 scroll-mt-6 font-barlow text-xl font-semibold uppercase tracking-wider text-[#C04810] first:mt-0"
      >
        {children}
      </h2>
    ),
    h3: ({ id, children }) => (
      <h3
        id={id}
        className="mb-2 mt-6 scroll-mt-6 text-base font-semibold text-[#1A1A16]"
      >
        {children}
      </h3>
    ),
    h4: ({ id, children }) => (
      <h4
        id={id}
        className="mb-1.5 mt-4 scroll-mt-6 font-barlow text-sm font-semibold uppercase tracking-widest text-[#4A4A42]"
      >
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p className="mb-4 leading-relaxed text-[#4A4A42]">{children}</p>
    ),
    a: ({ href, children }) => {
      const isInternalHash = href?.startsWith("#");

      return (
        <a
          href={href}
          className="text-[#C04810] underline underline-offset-2 hover:text-[#9A3A0E]"
          target={!isInternalHash && href?.startsWith("http") ? "_blank" : undefined}
          rel={!isInternalHash && href?.startsWith("http") ? "noopener noreferrer" : undefined}
          onClick={(e) => {
            if (isInternalHash && href) {
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
      <ul className="mb-4 ml-5 list-disc space-y-1.5 text-[#4A4A42]">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-[#4A4A42]">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-4 border-[#B8860B]/60 bg-[#B8860B]/8 px-4 py-3 text-sm text-[#C04810] [&>p]:mb-0 rounded-r-sm">
        {children}
      </blockquote>
    ),
    code: ({ className, children, ...props }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return (
          <code
            className="block overflow-x-auto whitespace-pre border border-[#B0AD9E] bg-[#E5E3DA] p-4 text-sm leading-relaxed text-[#1A1A16] rounded-sm"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          className="bg-[#E5E3DA] px-1.5 py-0.5 text-[0.8em] text-[#C04810] rounded-sm"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="mb-4 mt-1 overflow-x-auto border border-[#B0AD9E] bg-[#E5E3DA] rounded-sm">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="mb-6 overflow-x-auto border border-[#B0AD9E] rounded-sm">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-[#E5E3DA] text-[#4A4A42]">{children}</thead>
    ),
    tbody: ({ children }) => (
      <tbody className="divide-y divide-[#B0AD9E]">{children}</tbody>
    ),
    tr: ({ children }) => (
      <tr className="transition-colors hover:bg-[#E5E3DA]/60">{children}</tr>
    ),
    th: ({ children }) => (
      <th className="px-4 py-2.5 text-left font-barlow text-xs font-semibold uppercase tracking-wider text-[#7A7768]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-2.5 text-[#4A4A42]">{children}</td>
    ),
    hr: () => <hr className="my-8 border-[#B0AD9E]" />,
    strong: ({ children }) => (
      <strong className="font-semibold text-[#1A1A16]">{children}</strong>
    ),
    em: ({ children }) => <em className="italic text-[#4A4A42]">{children}</em>,
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
