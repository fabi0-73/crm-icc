/**
 * Shared icon set — one system, lucide, everywhere.
 *
 * These names predate the switch: eighteen hand-drawn SVGs (filled,
 * Material-2014 in feel) once lived here beside lucide's 2px strokes in the
 * rest of the app, so two icon languages met on every call screen. The
 * exports keep their names and props so no call site had to change; each is
 * now the lucide glyph at one stroke weight.
 *
 * Size stays a prop because the call surfaces size icons on purpose
 * (22–24 in call controls, 18–20 in chrome).
 */

import {
  ArrowLeft,
  AudioWaveform,
  ChevronDown,
  Hash,
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  Paperclip,
  Phone,
  PhoneOff,
  Plus,
  SendHorizontal,
  SquarePen,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";

type IconProps = { size?: number; className?: string };

/** One stroke weight for the whole set: heavier than lucide's default so
 *  glyphs hold up at 18px on a phone, lighter than the old filled shapes. */
const STROKE = 1.75;

function make(Glyph: LucideIcon, defaultSize: number) {
  return function Icon({ size = defaultSize, className = "" }: IconProps) {
    return (
      <Glyph
        size={size}
        strokeWidth={STROKE}
        className={className}
        aria-hidden
      />
    );
  };
}

export const PhoneIcon = make(Phone, 20);
export const HangUpIcon = make(PhoneOff, 24);
export const VideoIcon = make(Video, 16);
export const CamIcon = make(Video, 22);
export const CamOffIcon = make(VideoOff, 22);
export const BackIcon = make(ArrowLeft, 20);
export const SendIcon = make(SendHorizontal, 18);
export const PaperclipIcon = make(Paperclip, 20);
export const MinimizeIcon = make(ChevronDown, 20);
export const ExpandIcon = make(Maximize2, 14);
export const MicIcon = make(Mic, 22);
export const MicOffIcon = make(MicOff, 22);
export const HashIcon = make(Hash, 15);
export const ComposeIcon = make(SquarePen, 16);
export const PlusIcon = make(Plus, 14);
export const SignOutIcon = make(LogOut, 15);
export const NoiseIcon = make(AudioWaveform, 22);
export const ScreenShareIcon = make(MonitorUp, 22);
