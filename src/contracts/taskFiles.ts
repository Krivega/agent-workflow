import type { ArtifactRef } from './preparation.js';
export interface FileVersion {
  content: ArtifactRef;
  mode: number;
}
export interface TaskFileChange {
  path: string;
  before: FileVersion | null;
  after: FileVersion | null;
}
export interface TaskTree {
  files: { path: string; version: FileVersion }[];
  directories: { path: string; mode: number }[];
}
export interface TaskBinding {
  root: string;
  dev: string;
  ino: string;
}
