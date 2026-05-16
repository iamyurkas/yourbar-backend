export type LocalizedReference = {
  id: string;
  name: string;
};

export type RecipeTag = string | LocalizedReference;
export type RecipeMethod = string | string[] | LocalizedReference;

export type IngredientDetails = {
  id?: string;
  name?: string;
  description?: string;
  imageUrl?: string;
  tags?: RecipeTag[];
  [key: string]: unknown;
};

export type IngredientReference = string | IngredientDetails[];

export type Ingredient = {
  id?: string;
  baseIngredientId?: IngredientReference;
  styleIngredientId?: IngredientReference;
  name: string;
  description?: string;
  imageUrl?: string;
  tags?: RecipeTag[];
  amount?: number | string;
  unit?: string;
  unitId?: string;
  unitName?: string;
  note?: string;
  substitutes?: Ingredient[];
};

export type RecipeSharePayloadV1 = {
  schemaVersion: 1;
  kind: "yourbar.recipeShare";
  recipe: {
    name: string;
    description?: string;
    instructions?: string | string[];
    ingredients: Ingredient[];
    glassware?: string;
    glasswareId?: string;
    glasswareName?: string;
    garnish?: string;
    method?: RecipeMethod;
    methodId?: string;
    methodName?: string;
    tags?: RecipeTag[];
    servings?: number;
    imageUrl?: string;
    video?: string;
  };
  source?: {
    app: "yourbar";
    appVersion?: string;
    platform?: string;
  };
};

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: RecipeSharePayloadV1 }
  | { ok: false; issues: ValidationIssue[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalString(value: unknown, path: string, max: number, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isString(value)) {
    issues.push({ path, message: "Must be a string" });
    return;
  }
  if (value.length > max) {
    issues.push({ path, message: `Must be at most ${max} characters` });
  }
}

function stringOrStringArrayLength(value: unknown, path: string, maxTotal: number, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (isString(value)) {
    if (value.length > maxTotal) issues.push({ path, message: `Must be at most ${maxTotal} characters` });
    return;
  }
  if (Array.isArray(value) && value.every(isString)) {
    const total = value.reduce((sum, item) => sum + item.length, 0);
    if (total > maxTotal) issues.push({ path, message: `Must be at most ${maxTotal} characters total` });
    return;
  }
  issues.push({ path, message: "Must be a string or an array of strings" });
}

function methodValue(value: unknown, path: string, maxTotal: number, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (isObject(value)) {
    localizedReference(value, path, { idMax: 120, nameMax: 120 }, issues);
    return;
  }
  stringOrStringArrayLength(value, path, maxTotal, issues);
}

function localizedReference(value: unknown, path: string, options: { idMax: number; nameMax: number }, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path, message: "Must be an object" });
    return;
  }

  if (!isString(value.id) || value.id.trim().length < 1 || value.id.length > options.idMax) {
    issues.push({ path: `${path}.id`, message: `Must be a string with trimmed length from 1 to ${options.idMax}` });
  }

  if (!isString(value.name) || value.name.trim().length < 1 || value.name.length > options.nameMax) {
    issues.push({ path: `${path}.name`, message: `Must be a string with trimmed length from 1 to ${options.nameMax}` });
  }
}

function validateTags(value: unknown, path: string, options: { maxItems: number; stringMax: number; idMax: number; nameMax: number }, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > options.maxItems) {
    issues.push({ path, message: `Must be an array of up to ${options.maxItems} strings or localized tag objects` });
    return;
  }

  value.forEach((tag, index) => {
    const tagPath = `${path}[${index}]`;
    if (isString(tag)) {
      if (tag.length > options.stringMax) issues.push({ path: tagPath, message: `Must be at most ${options.stringMax} characters` });
      return;
    }
    localizedReference(tag, tagPath, { idMax: options.idMax, nameMax: options.nameMax }, issues);
  });
}

function validateHttpUrl(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isString(value)) {
    issues.push({ path, message: "Must be a string" });
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push({ path, message: "Must be an http or https URL" });
    }
  } catch {
    issues.push({ path, message: "Must be a valid URL" });
  }
}

function ingredientReference(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;

  if (isString(value)) {
    if (value.length > 120) issues.push({ path, message: "Must be at most 120 characters" });
    return;
  }

  if (!Array.isArray(value) || value.length > 80) {
    issues.push({ path, message: "Must be a string id or an array of ingredient detail objects" });
    return;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) {
      issues.push({ path: itemPath, message: "Ingredient details must be an object" });
      return;
    }

    optionalString(item.id, `${itemPath}.id`, 120, issues);
    optionalString(item.name, `${itemPath}.name`, 120, issues);
    optionalString(item.description, `${itemPath}.description`, 2000, issues);
    validateHttpUrl(item.imageUrl, `${itemPath}.imageUrl`, issues);
    validateTags(item.tags, `${itemPath}.tags`, { maxItems: 30, stringMax: 40, idMax: 120, nameMax: 40 }, issues);
  });
}

function validateIngredient(value: unknown, path: string, issues: ValidationIssue[], depth = 0): void {
  if (!isObject(value)) {
    issues.push({ path, message: "Ingredient must be an object" });
    return;
  }

  optionalString(value.id, `${path}.id`, 120, issues);
  ingredientReference(value.baseIngredientId, `${path}.baseIngredientId`, issues);
  ingredientReference(value.styleIngredientId, `${path}.styleIngredientId`, issues);
  if (!isString(value.name) || value.name.trim().length < 1 || value.name.trim().length > 120) {
    issues.push({ path: `${path}.name`, message: "Must be a string with trimmed length from 1 to 120" });
  }
  optionalString(value.description, `${path}.description`, 2000, issues);
  validateHttpUrl(value.imageUrl, `${path}.imageUrl`, issues);
  validateTags(value.tags, `${path}.tags`, { maxItems: 30, stringMax: 40, idMax: 120, nameMax: 40 }, issues);
  if (value.amount !== undefined && typeof value.amount !== "number" && !isString(value.amount)) {
    issues.push({ path: `${path}.amount`, message: "Must be a number or string" });
  }
  optionalString(value.unit, `${path}.unit`, 80, issues);
  optionalString(value.unitId, `${path}.unitId`, 80, issues);
  optionalString(value.unitName, `${path}.unitName`, 80, issues);
  optionalString(value.note, `${path}.note`, 240, issues);

  if (value.substitutes === undefined) return;
  if (!Array.isArray(value.substitutes) || value.substitutes.length > 80) {
    issues.push({ path: `${path}.substitutes`, message: "Must be an array of up to 80 substitute ingredient objects" });
    return;
  }
  if (depth >= 3) {
    issues.push({ path: `${path}.substitutes`, message: "Substitute ingredients may be nested up to 3 levels" });
    return;
  }

  value.substitutes.forEach((substitute, index) => validateIngredient(substitute, `${path}.substitutes[${index}]`, issues, depth + 1));
}

export function validateRecipeSharePayloadV1(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isObject(input)) {
    return { ok: false, issues: [{ path: "$", message: "Payload must be an object" }] };
  }

  if (input.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: "Must be 1" });
  }
  if (input.kind !== "yourbar.recipeShare") {
    issues.push({ path: "kind", message: 'Must be "yourbar.recipeShare"' });
  }

  if (!isObject(input.recipe)) {
    issues.push({ path: "recipe", message: "Recipe must be an object" });
  } else {
    const recipe = input.recipe;
    if (!isString(recipe.name) || recipe.name.trim().length < 1 || recipe.name.trim().length > 120) {
      issues.push({ path: "recipe.name", message: "Must be a string with trimmed length from 1 to 120" });
    }

    optionalString(recipe.description, "recipe.description", 2000, issues);
    stringOrStringArrayLength(recipe.instructions, "recipe.instructions", 8000, issues);
    methodValue(recipe.method, "recipe.method", 8000, issues);
    optionalString(recipe.methodId, "recipe.methodId", 120, issues);
    optionalString(recipe.methodName, "recipe.methodName", 120, issues);
    optionalString(recipe.glassware, "recipe.glassware", 120, issues);
    optionalString(recipe.glasswareId, "recipe.glasswareId", 120, issues);
    optionalString(recipe.glasswareName, "recipe.glasswareName", 120, issues);
    optionalString(recipe.garnish, "recipe.garnish", 240, issues);
    validateHttpUrl(recipe.imageUrl, "recipe.imageUrl", issues);
    validateHttpUrl(recipe.video, "recipe.video", issues);

    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length < 1 || recipe.ingredients.length > 80) {
      issues.push({ path: "recipe.ingredients", message: "Must be an array with length from 1 to 80" });
    } else {
      recipe.ingredients.forEach((ingredient, index) => validateIngredient(ingredient, `recipe.ingredients[${index}]`, issues));
    }

    validateTags(recipe.tags, "recipe.tags", { maxItems: 30, stringMax: 40, idMax: 120, nameMax: 40 }, issues);

    if (recipe.servings !== undefined) {
      if (typeof recipe.servings !== "number" || !Number.isInteger(recipe.servings) || recipe.servings < 1 || recipe.servings > 100) {
        issues.push({ path: "recipe.servings", message: "Must be an integer from 1 to 100" });
      }
    }
  }

  if (input.source !== undefined) {
    if (!isObject(input.source)) {
      issues.push({ path: "source", message: "Source must be an object" });
    } else {
      if (input.source.app !== "yourbar") issues.push({ path: "source.app", message: 'Must be "yourbar"' });
      optionalString(input.source.appVersion, "source.appVersion", 80, issues);
      optionalString(input.source.platform, "source.platform", 80, issues);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as RecipeSharePayloadV1 };
}
