/**
 * @fileoverview Recipe Controller for Zoneweaver Agent
 * @description CRUD operations for zlogin automation recipes and dry-run testing
 */

import Recipes from '../models/RecipeModel.js';
import { log } from '../lib/Logger.js';
import ZloginAutomation from '../lib/ZloginAutomation.js';

/**
 * @swagger
 * /provisioning/recipes:
 *   get:
 *     summary: List all recipes
 *     description: Returns all zlogin automation recipes, optionally filtered by os_family or brand.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: os_family
 *         schema:
 *           type: string
 *         description: Filter by OS family (linux, solaris, windows)
 *       - in: query
 *         name: brand
 *         schema:
 *           type: string
 *         description: Filter by zone brand (bhyve, lx, kvm)
 *     responses:
 *       200:
 *         description: List of recipes
 *       500:
 *         description: Failed to list recipes
 */
export const listRecipes = async (req, res) => {
  try {
    const { os_family, brand } = req.query;
    const where = {};

    if (os_family) {
      where.os_family = os_family;
    }
    if (brand) {
      where.brand = brand;
    }

    const recipes = await Recipes.findAll({ where, order: [['name', 'ASC']] });

    return res.json({
      success: true,
      count: recipes.length,
      recipes,
    });
  } catch (error) {
    log.api.error('Failed to list recipes', { error: error.message });
    return res.status(500).json({ error: 'Failed to list recipes', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/recipes:
 *   post:
 *     summary: Create a new recipe
 *     description: |
 *       Creates a new zlogin automation recipe.
 *       Recipes define step-by-step automation for early-boot zone configuration.
 *       Step types: wait, send, command, template, delay.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - os_family
 *               - steps
 *             properties:
 *               name:
 *                 type: string
 *                 description: Unique recipe name
 *               description:
 *                 type: string
 *               os_family:
 *                 type: string
 *                 enum: [linux, solaris, windows]
 *               brand:
 *                 type: string
 *                 default: bhyve
 *               is_default:
 *                 type: boolean
 *                 default: false
 *               boot_string:
 *                 type: string
 *                 description: Pattern indicating OS has booted
 *               login_prompt:
 *                 type: string
 *                 default: "login:"
 *               shell_prompt:
 *                 type: string
 *                 default: ":~$"
 *               timeout_seconds:
 *                 type: integer
 *                 default: 300
 *               steps:
 *                 type: array
 *                 items:
 *                   type: object
 *               variables:
 *                 type: object
 *     responses:
 *       201:
 *         description: Recipe created
 *       400:
 *         description: Invalid recipe data
 *       409:
 *         description: Recipe with that name already exists
 *       500:
 *         description: Failed to create recipe
 */
export const createRecipe = async (req, res) => {
  try {
    const { name, os_family, steps } = req.body;

    if (!name || !os_family || !steps || !Array.isArray(steps)) {
      return res.status(400).json({
        error: 'name, os_family, and steps (array) are required',
      });
    }

    // Validate step types
    const validTypes = ['wait', 'send', 'command', 'template', 'delay'];
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].type || !validTypes.includes(steps[i].type)) {
        return res.status(400).json({
          error: `Step ${i} has invalid type: ${steps[i].type}. Valid types: ${validTypes.join(', ')}`,
        });
      }
    }

    // Check for duplicate name
    const existing = await Recipes.findOne({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: `Recipe with name '${name}' already exists` });
    }

    // If setting as default, unset other defaults for same os_family+brand
    if (req.body.is_default) {
      const brand = req.body.brand || 'bhyve';
      await Recipes.update(
        { is_default: false },
        { where: { os_family, brand, is_default: true } }
      );
    }

    const recipe = await Recipes.create({
      name,
      description: req.body.description,
      os_family,
      brand: req.body.brand || 'bhyve',
      is_default: req.body.is_default || false,
      boot_string: req.body.boot_string,
      login_prompt: req.body.login_prompt || 'login:',
      shell_prompt: req.body.shell_prompt || ':~$',
      timeout_seconds: req.body.timeout_seconds || 300,
      steps,
      variables: req.body.variables || {},
      created_by: req.body.created_by,
    });

    log.api.info('Recipe created', { id: recipe.id, name });
    return res.status(201).json({ success: true, recipe });
  } catch (error) {
    log.api.error('Failed to create recipe', { error: error.message });
    return res.status(500).json({ error: 'Failed to create recipe', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/recipes/{id}:
 *   get:
 *     summary: Get recipe details
 *     description: Returns a single recipe by ID.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Recipe UUID
 *     responses:
 *       200:
 *         description: Recipe details
 *       404:
 *         description: Recipe not found
 *       500:
 *         description: Failed to get recipe
 */
export const getRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await Recipes.findByPk(id);

    if (!recipe) {
      return res.status(404).json({ error: `Recipe '${id}' not found` });
    }

    return res.json({ success: true, recipe });
  } catch (error) {
    log.api.error('Failed to get recipe', { error: error.message });
    return res.status(500).json({ error: 'Failed to get recipe', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/recipes/{id}:
 *   put:
 *     summary: Update a recipe
 *     description: Updates an existing recipe. Only provided fields are modified.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Recipe updated
 *       404:
 *         description: Recipe not found
 *       500:
 *         description: Failed to update recipe
 */
export const updateRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await Recipes.findByPk(id);

    if (!recipe) {
      return res.status(404).json({ error: `Recipe '${id}' not found` });
    }

    // Validate steps if provided
    if (req.body.steps) {
      const validTypes = ['wait', 'send', 'command', 'template', 'delay'];
      for (let i = 0; i < req.body.steps.length; i++) {
        if (!req.body.steps[i].type || !validTypes.includes(req.body.steps[i].type)) {
          return res.status(400).json({
            error: `Step ${i} has invalid type: ${req.body.steps[i].type}`,
          });
        }
      }
    }

    // If setting as default, unset other defaults
    if (req.body.is_default) {
      const osFamily = req.body.os_family || recipe.os_family;
      const brand = req.body.brand || recipe.brand;
      await Recipes.update(
        { is_default: false },
        { where: { os_family: osFamily, brand, is_default: true } }
      );
    }

    const allowedFields = [
      'name',
      'description',
      'os_family',
      'brand',
      'is_default',
      'boot_string',
      'login_prompt',
      'shell_prompt',
      'timeout_seconds',
      'steps',
      'variables',
      'created_by',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    updates.updated_at = new Date();

    await recipe.update(updates);

    log.api.info('Recipe updated', { id, name: recipe.name });
    return res.json({ success: true, recipe });
  } catch (error) {
    log.api.error('Failed to update recipe', { error: error.message });
    return res.status(500).json({ error: 'Failed to update recipe', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/recipes/{id}:
 *   delete:
 *     summary: Delete a recipe
 *     description: Permanently removes a recipe.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Recipe deleted
 *       404:
 *         description: Recipe not found
 *       500:
 *         description: Failed to delete recipe
 */
export const deleteRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await Recipes.findByPk(id);

    if (!recipe) {
      return res.status(404).json({ error: `Recipe '${id}' not found` });
    }

    const { name } = recipe;
    await recipe.destroy();

    log.api.info('Recipe deleted', { id, name });
    return res.json({ success: true, message: `Recipe '${name}' deleted` });
  } catch (error) {
    log.api.error('Failed to delete recipe', { error: error.message });
    return res.status(500).json({ error: 'Failed to delete recipe', details: error.message });
  }
};

/**
 * Resolve variables for preview (dry-run), keeping unresolved vars as-is
 * @param {string} str - String with {{variable}} placeholders
 * @param {Object} vars - Variable map
 * @returns {string}
 */
const resolveVarsPreview = (str, vars) => {
  if (!str) {
    return str;
  }
  return str.replace(/\{\{(?<varname>\w+)\}\}/gu, (match, ...args) => {
    const { varname } = args[args.length - 1];
    return vars[varname] !== undefined ? vars[varname] : match;
  });
};

/**
 * @swagger
 * /provisioning/recipes/{id}/test:
 *   post:
 *     summary: Test a recipe against a machine (dry-run or live)
 *     description: |
 *       Executes a recipe against a running machine (zone) for testing.
 *       The machine must be running and accessible via zlogin.
 *       Use dry_run: true to validate the recipe without executing.
 *     tags: [Provisioning Recipes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - machine_name
 *             properties:
 *               machine_name:
 *                 type: string
 *               variables:
 *                 type: object
 *               dry_run:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Recipe test results
 *       400:
 *         description: Missing machine_name
 *       404:
 *         description: Recipe not found
 *       500:
 *         description: Recipe test failed
 */
export const testRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const { machine_name, variables = {}, dry_run = false } = req.body;

    if (!machine_name) {
      return res.status(400).json({ error: 'machine_name is required' });
    }

    const recipe = await Recipes.findByPk(id);
    if (!recipe) {
      return res.status(404).json({ error: `Recipe '${id}' not found` });
    }

    if (dry_run) {
      // Validate recipe steps and variable resolution without executing
      const mergedVars = { ...recipe.variables, ...variables };
      const resolvedSteps = recipe.steps.map((step, i) => {
        const resolved = { step: i, type: step.type };
        if (step.pattern) {
          resolved.pattern = resolveVarsPreview(step.pattern, mergedVars);
        }
        if (step.value) {
          resolved.value = resolveVarsPreview(step.value, mergedVars);
        }
        if (step.content) {
          resolved.content = resolveVarsPreview(step.content, mergedVars);
        }
        if (step.dest) {
          resolved.dest = resolveVarsPreview(step.dest, mergedVars);
        }
        if (step.seconds) {
          resolved.seconds = step.seconds;
        }
        return resolved;
      });

      // Check for unresolved variables
      const unresolvedVars = new Set();
      JSON.stringify(resolvedSteps).replace(/\{\{(?<varname>\w+)\}\}/gu, (...args) => {
        const { varname } = args[args.length - 1];
        unresolvedVars.add(varname);
      });

      return res.json({
        success: true,
        dry_run: true,
        recipe_name: recipe.name,
        machine_name,
        resolved_steps: resolvedSteps,
        unresolved_variables: [...unresolvedVars],
        variables_provided: Object.keys(variables),
        variables_default: Object.keys(recipe.variables || {}),
      });
    }

    // Live execution
    const automation = new ZloginAutomation(machine_name, {
      globalTimeout: (recipe.timeout_seconds || 300) * 1000,
    });

    try {
      const result = await automation.execute(recipe, variables);

      return res.json({
        success: result.success,
        recipe_name: recipe.name,
        machine_name,
        output: result.output,
        errors: result.errors,
        log: result.log,
      });
    } finally {
      automation.destroy();
    }
  } catch (error) {
    log.api.error('Recipe test failed', { error: error.message });
    return res.status(500).json({ error: 'Recipe test failed', details: error.message });
  }
};
