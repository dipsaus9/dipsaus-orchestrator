// Fixture: the worker host does not write run state such as questions (0006 decision 8).
import { insertWorkerQuestion } from "../run-state/questions";

export const leaked = insertWorkerQuestion;
