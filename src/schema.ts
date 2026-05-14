export type Ingredient = {
  name: string;
  amount?: number | string;
  unit?: string;
  note?: string;
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
    garnish?: string;
    method?: string | string[];
    tags?: string[];
    servings?: number;
    imageUrl?: string;
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
    stringOrStringArrayLength(recipe.method, "recipe.method", 8000, issues);
    optionalString(recipe.glassware, "recipe.glassware", 120, issues);
    optionalString(recipe.garnish, "recipe.garnish", 240, issues);
    validateHttpUrl(recipe.imageUrl, "recipe.imageUrl", issues);

    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length < 1 || recipe.ingredients.length > 80) {
      issues.push({ path: "recipe.ingredients", message: "Must be an array with length from 1 to 80" });
    } else {
      recipe.ingredients.forEach((ingredient, index) => {
        const path = `recipe.ingredients[${index}]`;
        if (!isObject(ingredient)) {
          issues.push({ path, message: "Ingredient must be an object" });
          return;
        }
        if (!isString(ingredient.name) || ingredient.name.trim().length < 1 || ingredient.name.trim().length > 120) {
          issues.push({ path: `${path}.name`, message: "Must be a string with trimmed length from 1 to 120" });
        }
        if (ingredient.amount !== undefined && typeof ingredient.amount !== "number" && !isString(ingredient.amount)) {
          issues.push({ path: `${path}.amount`, message: "Must be a number or string" });
        }
        optionalString(ingredient.unit, `${path}.unit`, 80, issues);
        optionalString(ingredient.note, `${path}.note`, 240, issues);
      });
    }

    if (recipe.tags !== undefined) {
      if (!Array.isArray(recipe.tags) || recipe.tags.length > 30 || !recipe.tags.every((tag) => isString(tag) && tag.length <= 40)) {
        issues.push({ path: "recipe.tags", message: "Must be an array of up to 30 strings, each at most 40 characters" });
      }
    }

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
