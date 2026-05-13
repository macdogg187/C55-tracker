"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-6 text-3xl font-bold tracking-tight text-zinc-100">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-10 text-xl font-semibold text-cyan-300 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-6 text-base font-semibold text-zinc-200">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-sm font-semibold uppercase tracking-widest text-zinc-400">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-4 leading-relaxed text-zinc-300">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300"
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-4 ml-5 list-disc space-y-1.5 text-zinc-300">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-zinc-300">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-amber-600/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200 [&>p]:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code
          className="block overflow-x-auto whitespace-pre rounded-lg border border-zinc-700 bg-zinc-900 p-4 font-mono text-sm leading-relaxed text-zinc-200"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[0.8em] text-cyan-300"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-4 mt-1 overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-900">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-6 overflow-x-auto rounded-lg border border-zinc-700">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-zinc-800/80 text-zinc-300">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-zinc-800">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="transition-colors hover:bg-zinc-800/40">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-zinc-300">{children}</td>
  ),
  hr: () => <hr className="my-8 border-zinc-800" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-100">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
};

export function GlossaryContent({ markdown }: { markdown: string }) {
  return (
    <article>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
