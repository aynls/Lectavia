import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { BookmarkSimpleIcon } from "@phosphor-icons/react/dist/csr/BookmarkSimple";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FilmStripIcon } from "@phosphor-icons/react/dist/csr/FilmStrip";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TextTIcon } from "@phosphor-icons/react/dist/csr/TextT";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { WaveformIcon } from "@phosphor-icons/react/dist/csr/Waveform";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

const icons = {
  arrow: ArrowRightIcon,
  back: ArrowLeftIcon,
  bookmark: BookmarkSimpleIcon,
  down: CaretDownIcon,
  video: FilmStripIcon,
  folder: FolderOpenIcon,
  link: LinkSimpleIcon,
  list: ListBulletsIcon,
  waveform: WaveformIcon,
  text: TextTIcon,
  document: FileTextIcon,
  save: FloppyDiskIcon,
  plus: PlusIcon,
  settings: SlidersHorizontalIcon,
  check: CheckCircleIcon,
  copy: CopyIcon,
  upload: UploadSimpleIcon,
  warning: WarningCircleIcon,
  close: XIcon,
};

export function Icon({ name }: { name: keyof typeof icons }) {
  const Glyph = icons[name];
  return <Glyph className="icon" aria-hidden="true" />;
}
