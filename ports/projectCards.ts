import type {
  CardCompletion,
  CardProjection,
  CardSnapshot,
  ProjectionResult,
  ProjectStatus,
} from '../core/card.js';
export interface ProjectCards {
  read(locator: string): Promise<CardSnapshot>;
  prepare(
    card: CardSnapshot,
    status: ProjectStatus,
    operation: string,
    completion?: CardCompletion,
  ): Promise<CardProjection>;
  apply(projection: CardProjection): Promise<ProjectionResult>;
}
