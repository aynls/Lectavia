import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FilmStripIcon } from "@phosphor-icons/react/dist/csr/FilmStrip";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TextTIcon } from "@phosphor-icons/react/dist/csr/TextT";
import { WaveformIcon } from "@phosphor-icons/react/dist/csr/Waveform";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

const icons = {
  arrow: ArrowRightIcon,
  down: CaretDownIcon,
  video: FilmStripIcon,
  folder: FolderOpenIcon,
  link: LinkSimpleIcon,
  waveform: WaveformIcon,
  text: TextTIcon,
  document: FileTextIcon,
  save: FloppyDiskIcon,
  settings: SlidersHorizontalIcon,
  close: XIcon,
};

export function Icon({ name }: { name: keyof typeof icons }) {
  const Glyph = icons[name];
  return <Glyph className="icon" aria-hidden="true" />;
}
