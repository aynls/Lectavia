const paths = {
  book: "M12 7v14m0-14C9 4 5 4 2 5v14c3-1 7-1 10 2 3-3 7-3 10-2V5c-3-1-7-1-10 2Z",
  video:
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M10 9l5 3-5 3V9Z",
  folder:
    "M3 18V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  link: "M10 13a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7m2.4 4.5a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7",
  down: "m6 9 6 6 6-6",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  close: "m6 6 12 12M6 18 18 6",
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
