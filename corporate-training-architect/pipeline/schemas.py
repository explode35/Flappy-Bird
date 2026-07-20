"""Pydantic schemas for the structured-output stages of the pipeline.

Kept deliberately flat: the structured-outputs API does not support recursive
schemas or numeric/string constraints, so these models use only basic types,
lists, and nested objects.
"""

from typing import List

from pydantic import BaseModel


class Concept(BaseModel):
    name: str
    definition: str
    why_it_matters: str
    source_quote: str  # short verbatim quote from the transcript that grounds it


class ProcessStep(BaseModel):
    name: str
    description: str
    inputs: List[str]
    outputs: List[str]
    common_mistakes: List[str]


class FrameworkMap(BaseModel):
    """Stage 1 output: the expert's operational framework, structured."""

    expert_name: str
    domain: str
    framework_name: str
    core_thesis: str
    target_learner: str
    concepts: List[Concept]
    processes: List[ProcessStep]
    heuristics: List[str]  # rules of thumb / judgment calls the expert uses
    vocabulary: List[str]  # terms of art, each as "term: definition"
    gaps_to_clarify: List[str]  # questions to take back to the client before delivery


class WeekOutline(BaseModel):
    week: int
    title: str
    module_name: str
    objectives: List[str]  # observable, assessable learning objectives
    key_concepts: List[str]  # names referencing FrameworkMap concepts/processes


class ModuleOutline(BaseModel):
    number: int
    name: str
    summary: str
    week_numbers: List[int]


class CurriculumOutline(BaseModel):
    """Stage 2 output: the full program skeleton."""

    program_title: str
    audience: str
    program_promise: str  # what a learner can do after completing the program
    modules: List[ModuleOutline]
    weeks: List[WeekOutline]
