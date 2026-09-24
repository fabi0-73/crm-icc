export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-line bg-mist">
      <tr>{children}</tr>
    </thead>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line bg-paper">{children}</tbody>;
}

export function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-[12px] font-medium text-muted">
      {children}
    </th>
  );
}

export function Td({
  className = "",
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return <td className={`px-4 py-3 ${className}`}>{children}</td>;
}
