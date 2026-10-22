/**
 * Build Your Own Masala Mix
 * Script for sections/masala-mix-builder.liquid. Vanilla JS, no dependencies.
 *
 * Each section instance is a <masala-mix-builder> custom element: it initialises
 * itself when connected and removes its listeners when disconnected, so it works
 * with several instances per page and with theme editor section reloads.
 *
 * Money is handled in integer currency subunits (cents) and weight in integer
 * milligrams, so totals never accumulate floating-point error.
 */
(() => {
  'use strict';

  if (customElements.get('masala-mix-builder')) return;

  const REQUEST_TIMEOUT_MS = 15000;
  const CARD_LOCK_MS = 400;
  const MAX_PAGE_REQUESTS = 40;

  const MG_PER_UNIT = { mg: 1, g: 1000, kg: 1000000, lb: 453592.37, oz: 28349.5231 };
  const UNIT_ALIASES = {
    mg: 'mg', milligram: 'mg', milligrams: 'mg',
    g: 'g', gm: 'g', gms: 'g', gr: 'g', grm: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
    kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    oz: 'oz', ounce: 'oz', ounces: 'oz'
  };
  const WEIGHT_PATTERN =
    /(\d+(?:[.,]\d+)?)\s*(milligrams?|mg|kilograms?|kilos?|kgs?|grammes?|grams?|grm|gms|gm|gr|g|pounds?|lbs?|ounces?|oz)(?![a-z])/i;

  /* ------------------------------------------------------------------------
     Helpers
     ------------------------------------------------------------------------ */

  function toMilligrams(value, unit = 'g') {
    if (typeof value === 'string' && /[a-z]/i.test(value)) return parseWeight(value);
    const amount = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
    const key = UNIT_ALIASES[String(unit || 'g').trim().toLowerCase()];
    if (!Number.isFinite(amount) || amount <= 0 || !key) return null;
    return Math.round(amount * MG_PER_UNIT[key]);
  }

  function parseWeight(text) {
    const match = text == null ? null : String(text).match(WEIGHT_PATTERN);
    return match ? toMilligrams(match[1], match[2]) : null;
  }

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fill(template, values = {}) {
    return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
  }

  function toInt(value, fallback = 0) {
    const number = parseInt(value, 10);
    return Number.isFinite(number) ? number : fallback;
  }

  function gramsToMg(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) : 0;
  }

  /** Strips HTML (e.g. <span class=money>) and decodes entities from shop.money_format. */
  function decodeMoneyFormat(format) {
    const doc = new DOMParser().parseFromString(String(format || '{{amount}}'), 'text/html');
    return doc.body.textContent || '{{amount}}';
  }

  /** Shopify-compatible money formatting from integer subunits. */
  function formatMoney(cents, format) {
    const subunits = Math.max(0, Math.round(Number(cents) || 0));
    const render = (decimals, thousands, decimal) => {
      const whole = decimals ? Math.floor(subunits / 100) : Math.round(subunits / 100);
      const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return decimals ? `${grouped}${decimal}${String(subunits % 100).padStart(2, '0')}` : grouped;
    };
    const formats = {
      amount: () => render(2, ',', '.'),
      amount_no_decimals: () => render(0, ',', '.'),
      amount_with_comma_separator: () => render(2, '.', ','),
      amount_no_decimals_with_comma_separator: () => render(0, '.', ','),
      amount_with_space_separator: () => render(2, ' ', ','),
      amount_no_decimals_with_space_separator: () => render(0, ' ', ','),
      amount_with_apostrophe_separator: () => render(2, "'", '.'),
      amount_with_period_and_space_separator: () => render(2, ' ', '.')
    };
    return format.replace(/\{\{\s*(\w+)\s*\}\}/, (match, key) => (formats[key] || formats.amount)());
  }

  class CartRequestError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'CartRequestError';
      this.status = status;
    }
  }

  /* ------------------------------------------------------------------------
     Custom element
     ------------------------------------------------------------------------ */

  class MasalaMixBuilder extends HTMLElement {
    connectedCallback() {
      if (this.ready) return;
      const configEl = this.querySelector('script[data-mmb-config]');
      if (!configEl) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => this.connectedCallback(), { once: true });
        }
        return;
      }
      try {
        this.config = JSON.parse(configEl.textContent);
      } catch (error) {
        console.error('[Masala Mix] Could not read section settings.', error);
        return;
      }
      this.ready = true;
      this.setup();
    }

    disconnectedCallback() {
      if (!this.ready) return;
      this.ready = false;
      this.controller.abort();
      if (this.observer) this.observer.disconnect();
      this.timers.forEach((timer) => clearTimeout(timer));
      this.timers.clear();
    }

    /* ---------------------------- Setup ---------------------------------- */

    setup() {
      const c = this.config;
      this.strings = c.strings || {};
      this.controller = new AbortController();
      this.timers = new Set();
      this.products = new Map(); // productId -> normalized product
      this.selection = new Map(); // productId -> variantId chosen on the card
      this.bundle = new Map(); // productId -> { productId, variantId, quantity }
      this.lineNodes = new Map(); // productId -> <li> in the summary
      this.lockedCards = new Set();
      this.submitting = false;
      this.query = '';

      this.moneyFormat = decodeMoneyFormat(c.moneyFormat);
      const locale = c.locale || document.documentElement.lang || undefined;
      try {
        this.gramFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
        this.kgFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
        this.pluralRules = new Intl.PluralRules(locale);
        this.locale = locale;
      } catch (error) {
        this.gramFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
        this.kgFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
        this.pluralRules = new Intl.PluralRules();
        this.locale = undefined;
      }

      const limits = c.limits || {};
      this.limits = {
        minMg: gramsToMg(limits.minWeight),
        maxMg: gramsToMg(limits.maxWeight),
        minProducts: Math.max(0, toInt(limits.minProducts)),
        maxProducts: Math.max(0, toInt(limits.maxProducts)),
        maxQty: Math.max(1, toInt(limits.maxQtyPerItem, 99))
      };
      if (this.limits.maxMg && this.limits.minMg > this.limits.maxMg) this.limits.minMg = 0;
      if (this.limits.maxProducts && this.limits.minProducts > this.limits.maxProducts) this.limits.minProducts = 0;

      const pricing = c.pricing || {};
      this.strategy = ['sum', 'fixed', 'weight'].includes(pricing.strategy) ? pricing.strategy : 'sum';
      this.cartMode = c.cart && c.cart.mode === 'bundle_product' ? 'bundle_product' : 'individual';
      this.unitMg = gramsToMg(pricing.weightUnitGrams) || 10000;
      this.tiers = (pricing.weightTiers || [])
        .map((tier) => ({ minMg: gramsToMg(tier.minGrams), price: Math.max(0, toInt(tier.pricePerUnit)) }))
        .sort((a, b) => b.minMg - a.minMg);
      this.weightRequired = Boolean(this.limits.minMg || this.limits.maxMg || this.strategy === 'weight');
      this.defaultWeightMg = parseWeight(c.catalog && c.catalog.defaultWeight);
      this.bundleVariant = this.readBundleVariant();

      this.pagination = {
        type: (c.pagination && c.pagination.type) || 'load_more',
        page: Math.max(1, toInt(c.pagination && c.pagination.currentPage, 1)),
        totalPages: Math.max(1, toInt(c.pagination && c.pagination.totalPages, 1)),
        totalItems: toInt(c.pagination && c.pagination.totalItems)
      };

      this.cacheElements();
      this.bindEvents();
      this.registerCards(this.els.grid ? Array.from(this.els.grid.querySelectorAll('[data-mmb-card]')) : []);
      this.render();
      this.updatePaginationUI();
      this.reportMissingWeights();
      this.initSavedBlend();
      this.initMobileBar();

      if (this.pagination.type === 'all' && this.hasMorePages()) {
        this.loadAllPages().catch(() => this.setLoadMoreError(this.strings.loadMoreError));
      }
    }

    readBundleVariant() {
      const bundle = this.config.cart && this.config.cart.bundleProduct;
      if (!bundle || !bundle.variant) return null;
      return {
        id: String(bundle.variant.id),
        price: Math.max(0, toInt(bundle.variant.price)),
        available: Boolean(bundle.variant.available)
      };
    }

    cacheElements() {
      const q = (selector) => this.querySelector(selector);
      this.els = {
        grid: q('[data-mmb-grid]'),
        gridEmpty: q('[data-mmb-grid-empty]'),
        search: q('[data-mmb-search]'),
        searchClear: q('[data-mmb-action="clear-search"]'),
        searchStatus: q('[data-mmb-search-status]'),
        noResults: q('[data-mmb-no-results]'),
        loadMoreWrap: q('[data-mmb-more]'),
        loadMore: q('[data-mmb-action="load-more"]'),
        loadMoreLabel: q('[data-mmb-load-more-label]'),
        loadMoreCount: q('[data-mmb-more-count]'),
        loadMoreError: q('[data-mmb-more-error]'),
        summary: q('[data-mmb-summary]'),
        summaryTitle: q('[data-mmb-summary-title]'),
        count: q('[data-mmb-count]'),
        totalWeight: q('[data-mmb-total-weight]'),
        progress: q('[data-mmb-progress]'),
        progressBar: q('[data-mmb-progress-bar]'),
        progressMin: q('[data-mmb-progress-min]'),
        weightNote: q('[data-mmb-weight-note]'),
        lines: q('[data-mmb-lines]'),
        empty: q('[data-mmb-empty]'),
        subtotalRow: q('[data-mmb-subtotal-row]'),
        subtotal: q('[data-mmb-subtotal]'),
        savingsRow: q('[data-mmb-savings-row]'),
        savings: q('[data-mmb-savings]'),
        total: q('[data-mmb-total]'),
        pricingNote: q('[data-mmb-pricing-note]'),
        hint: q('[data-mmb-hint]'),
        addToCart: q('[data-mmb-action="add-to-cart"]'),
        addToCartLabel: q('[data-mmb-add-to-cart-label]'),
        message: q('[data-mmb-message]'),
        save: q('[data-mmb-action="save"]'),
        saved: q('[data-mmb-saved]'),
        savedLabel: q('[data-mmb-saved-label]'),
        forget: q('[data-mmb-action="forget"]'),
        reset: q('[data-mmb-action="reset"]'),
        resetConfirm: q('[data-mmb-reset-confirm]'),
        resetConfirmText: q('[data-mmb-reset-confirm-text]'),
        resetCancel: q('[data-mmb-action="reset-cancel"]'),
        bar: q('[data-mmb-bar]'),
        barText: q('[data-mmb-bar-text]'),
        notices: q('[data-mmb-editor-notices]'),
        livePolite: q('[data-mmb-live="polite"]'),
        liveAssertive: q('[data-mmb-live="assertive"]'),
        lineTemplate: q('template[data-mmb-line-template]')
      };
    }

    bindEvents() {
      const options = { signal: this.controller.signal };
      this.addEventListener('click', (event) => this.onClick(event), options);
      this.addEventListener('change', (event) => this.onChange(event), options);
      this.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'Escape') return;
          if (this.els.resetConfirm && !this.els.resetConfirm.hidden && this.els.resetConfirm.contains(event.target)) {
            event.preventDefault();
            this.cancelReset();
          } else if (event.target === this.els.search && this.els.search.value) {
            event.preventDefault();
            this.clearSearch();
          }
        },
        options
      );
      if (this.els.search) {
        this.els.search.addEventListener('input', () => this.onSearchInput(), options);
      }
    }

    later(callback, delay) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        callback();
      }, delay);
      this.timers.add(timer);
      return timer;
    }

    clearTimer(timer) {
      if (!timer) return;
      clearTimeout(timer);
      this.timers.delete(timer);
    }

    /* ------------------------ Product registry --------------------------- */

    registerCards(cards) {
      let added = 0;
      cards.forEach((card) => {
        const script = card.querySelector('script[data-mmb-product]');
        if (!script) return;
        let data;
        try {
          data = JSON.parse(script.textContent);
        } catch (error) {
          console.warn('[Masala Mix] Skipping a product with unreadable data.', error);
          return;
        }
        const id = String(data.id);
        const existing = this.products.get(id);
        if (existing && existing.card !== card) {
          card.remove(); // duplicate returned by a later page (collection changed between requests)
          return;
        }
        const product = this.normalizeProduct(data, card);
        this.products.set(id, product);
        this.selection.set(id, this.defaultVariantId(product));
        this.syncCard(id);
        added += 1;
      });
      return added;
    }

    normalizeProduct(data, card) {
      const c = this.config.catalog || {};
      const weightNames = (c.weightOptionNames || []).map(normalizeText).filter(Boolean);
      const optionNames = Array.isArray(data.options) ? data.options : [];
      const weightIndex = optionNames.findIndex((name) => weightNames.includes(normalizeText(name)));

      const variants = (data.variants || []).map((raw) => {
        const options = Array.isArray(raw.options) ? raw.options.map(String) : [];
        let mg = null;
        if (raw.metaWeight && raw.metaWeight.value != null) mg = toMilligrams(raw.metaWeight.value, raw.metaWeight.unit);
        if (mg == null && weightIndex > -1) mg = parseWeight(options[weightIndex]);
        for (let i = 0; mg == null && i < options.length; i += 1) mg = parseWeight(options[i]);
        if (mg == null) mg = parseWeight(raw.title);
        if (mg == null && c.useShippingWeight && Number(raw.shippingWeight) > 0) mg = Math.round(Number(raw.shippingWeight) * 1000);

        const rule = raw.quantityRule || {};
        const step = Math.max(1, toInt(rule.increment, 1));
        const min = Math.max(1, toInt(rule.min, 1));
        let max = this.limits.maxQty;
        if (rule.max != null && toInt(rule.max) > 0) max = Math.min(max, toInt(rule.max));
        if (raw.inventoryCap != null) max = Math.min(max, Math.max(0, toInt(raw.inventoryCap)));

        return {
          id: String(raw.id),
          title: String(raw.title || ''),
          options,
          price: Math.max(0, toInt(raw.price)),
          available: Boolean(raw.available) && max >= min,
          mg,
          image: raw.image || null,
          min,
          max,
          step
        };
      });

      const regionalName = data.regionalName ? String(data.regionalName) : '';
      return {
        id: String(data.id),
        handle: String(data.handle || ''),
        title: String(data.title || ''),
        regionalName,
        image: data.image || null,
        initialVariantId: data.initialVariantId != null ? String(data.initialVariantId) : null,
        hasOnlyDefaultVariant: Boolean(data.hasOnlyDefaultVariant),
        optionCount: optionNames.length,
        variants,
        variantMap: new Map(variants.map((variant) => [variant.id, variant])),
        searchText: normalizeText(`${data.title} ${regionalName} ${String(data.handle || '').replace(/-/g, ' ')}`),
        card,
        msgTimer: null
      };
    }

    defaultVariantId(product) {
      if (this.defaultWeightMg) {
        const match = product.variants.find((v) => v.available && v.mg === this.defaultWeightMg);
        if (match) return match.id;
      }
      const initial = product.initialVariantId && product.variantMap.get(product.initialVariantId);
      if (initial && initial.available) return initial.id;
      const fallback = product.variants.find((v) => v.available) || product.variants[0];
      return fallback ? fallback.id : null;
    }

    getVariant(productId, variantId) {
      const product = this.products.get(productId);
      return product ? product.variantMap.get(String(variantId)) || null : null;
    }

    /* ----------------------------- Cards --------------------------------- */

    syncCard(productId) {
      const product = this.products.get(productId);
      if (!product) return;
      const s = this.strings;
      const card = product.card;
      const line = this.bundle.get(productId);
      const variantId = line ? line.variantId : this.selection.get(productId);
      const variant = variantId ? product.variantMap.get(variantId) : null;

      if (variant) {
        card.querySelectorAll('[data-mmb-option-group]').forEach((group) => {
          const index = toInt(group.dataset.mmbOptionGroup);
          group.querySelectorAll('input[type="radio"]').forEach((input) => {
            input.checked = input.value === variant.options[index];
            const available = this.isOptionValueAvailable(product, index, input.value, variant);
            const pill = input.closest('.mmb-pill');
            if (pill) pill.classList.toggle('is-unavailable', !available);
            if (product.optionCount === 1) input.disabled = !available && !input.checked;
          });
        });
      }

      const price = card.querySelector('[data-mmb-card-price]');
      if (price && variant) price.textContent = this.money(variant.price);

      const weight = card.querySelector('[data-mmb-card-weight]');
      if (weight) {
        const label = variant && variant.mg != null ? this.formatWeight(variant.mg) : '';
        weight.textContent = label;
        weight.hidden = !label;
      }

      const inBundle = Boolean(line);
      const purchasable = Boolean(variant && variant.available);
      card.classList.toggle('is-selected', inBundle);

      const button = card.querySelector('[data-mmb-action="toggle"]');
      const buttonLabel = card.querySelector('[data-mmb-add-label]');
      if (button) {
        button.disabled = !inBundle && !purchasable;
        let text = s.add;
        let aria = fill(s.addToMix, { title: product.title });
        if (inBundle) {
          text = s.added;
          aria = fill(s.removeFromMix, { title: product.title });
        } else if (!purchasable) {
          text = variant ? s.soldOut : s.unavailable;
          aria = `${product.title}: ${text}`;
        }
        if (buttonLabel) buttonLabel.textContent = text;
        button.setAttribute('aria-label', aria);
      }
    }

    isOptionValueAvailable(product, index, value, current) {
      return product.variants.some(
        (variant) =>
          variant.available &&
          variant.options[index] === value &&
          variant.options.every((option, i) => i === index || option === current.options[i])
      );
    }

    variantFromCard(product) {
      const values = [];
      product.card.querySelectorAll('[data-mmb-option-group]').forEach((group) => {
        const checked = group.querySelector('input[type="radio"]:checked');
        values[toInt(group.dataset.mmbOptionGroup)] = checked ? checked.value : null;
      });
      return product.variants.find((variant) => variant.options.every((option, i) => values[i] == null || values[i] === option)) || null;
    }

    lockCard(product) {
      this.lockedCards.add(product.id);
      product.card.classList.add('is-busy');
      product.card.setAttribute('aria-busy', 'true');
      this.later(() => {
        this.lockedCards.delete(product.id);
        product.card.classList.remove('is-busy');
        product.card.removeAttribute('aria-busy');
      }, CARD_LOCK_MS);
    }

    notifyCard(product, text) {
      const el = product.card.querySelector('[data-mmb-card-msg]');
      if (el) {
        el.textContent = text;
        el.hidden = false;
        this.clearTimer(product.msgTimer);
        product.msgTimer = this.later(() => {
          el.hidden = true;
        }, 5000);
      }
      this.announce(text, true);
    }

    /* ------------------------- Event handlers ---------------------------- */

    onClick(event) {
      const trigger = event.target.closest('[data-mmb-action]');
      if (!trigger || !this.contains(trigger)) return;
      if (trigger.getAttribute('aria-disabled') === 'true' && !trigger.hasAttribute('data-mmb-allow-disabled')) return;
      const holder = trigger.closest('[data-product-id]');
      const productId = holder ? holder.dataset.productId : null;

      switch (trigger.dataset.mmbAction) {
        case 'toggle':
          this.toggleProduct(productId);
          break;
        case 'decrease':
          this.changeQuantity(productId, -1);
          break;
        case 'increase':
          this.changeQuantity(productId, 1);
          break;
        case 'remove':
          this.removeLine(productId);
          break;
        case 'add-to-cart':
          this.addToCart();
          break;
        case 'save':
          this.saveBlend();
          break;
        case 'restore':
          this.restoreBlend();
          break;
        case 'forget':
          this.forgetBlend();
          break;
        case 'reset':
          this.requestReset();
          break;
        case 'reset-confirm':
          this.resetAll();
          break;
        case 'reset-cancel':
          this.cancelReset();
          break;
        case 'load-more':
          this.onLoadMore();
          break;
        case 'clear-search':
          this.clearSearch();
          break;
        case 'view-mix':
          this.scrollToSummary();
          break;
        default:
          break;
      }
    }

    onChange(event) {
      const target = event.target;
      if (target.matches('[data-mmb-variant-select]')) {
        const holder = target.closest('[data-product-id]');
        if (holder) this.setLineVariant(holder.dataset.productId, target.value, { fromCard: false });
        return;
      }
      if (target.matches('[data-mmb-option-group] input[type="radio"]')) {
        const card = target.closest('[data-mmb-card]');
        if (card) this.onCardOptionChange(card.dataset.productId);
      }
    }

    onCardOptionChange(productId) {
      const product = this.products.get(productId);
      if (!product) return;
      const variant = this.variantFromCard(product);

      if (this.bundle.has(productId)) {
        if (!variant) {
          this.notifyCard(product, this.strings.unavailable);
          this.syncCard(productId);
          return;
        }
        this.setLineVariant(productId, variant.id, { fromCard: true });
        return;
      }

      this.selection.set(productId, variant ? variant.id : null);
      this.syncCard(productId);
    }

    /* ------------------------ Bundle mutations --------------------------- */

    toggleProduct(productId) {
      const product = this.products.get(productId);
      if (!product || this.lockedCards.has(productId)) return;
      this.lockCard(product);
      if (this.bundle.has(productId)) this.removeLine(productId);
      else this.addProduct(productId);
    }

    addProduct(productId) {
      const product = this.products.get(productId);
      const s = this.strings;
      const variant = product.variantMap.get(this.selection.get(productId));
      if (this.limits.maxProducts && this.bundle.size >= this.limits.maxProducts) {
        this.notifyCard(product, fill(s.maxProducts, { max: this.limits.maxProducts }));
        return;
      }
      const quantity = variant ? variant.min : 1;
      const error = this.checkLine(product, variant, quantity);
      if (error) {
        this.notifyCard(product, error);
        return;
      }
      this.bundle.set(productId, { productId, variantId: variant.id, quantity });
      this.highlightId = productId;
      this.commit([productId]);
      this.announce(
        fill(s.lineAdded, {
          title: product.title,
          weight: this.lineWeightText(variant, quantity),
          total: this.formatWeight(this.getTotals().mg)
        })
      );
    }

    setLineVariant(productId, variantId, { fromCard }) {
      const line = this.bundle.get(productId);
      const product = this.products.get(productId);
      if (!line || !product) return;
      const variant = product.variantMap.get(String(variantId));
      const quantity = variant ? this.clampQuantity(line.quantity, variant) : line.quantity;
      const error = this.checkLine(product, variant, quantity);
      if (error) {
        this.render([productId]); // restores the select / pills to the current line
        if (fromCard) this.notifyCard(product, error);
        else this.showMessage(error, 'error');
        return;
      }
      line.variantId = variant.id;
      line.quantity = quantity;
      this.selection.set(productId, variant.id);
      this.commit([productId]);
      this.announce(
        fill(this.strings.lineUpdated, {
          title: product.title,
          weight: this.lineWeightText(variant, quantity),
          total: this.formatWeight(this.getTotals().mg)
        })
      );
    }

    changeQuantity(productId, direction) {
      const line = this.bundle.get(productId);
      const product = this.products.get(productId);
      if (!line || !product) return;
      const variant = product.variantMap.get(line.variantId);
      if (!variant) return;
      const next = line.quantity + direction * variant.step;
      if (next < variant.min) return;
      if (next > variant.max) {
        this.showMessage(fill(this.strings.maxQuantity, { max: variant.max, title: product.title }), 'error');
        return;
      }
      if (direction > 0) {
        const error = this.checkLine(product, variant, next);
        if (error) {
          this.showMessage(error, 'error');
          return;
        }
      }
      line.quantity = next;
      this.commit([productId]);
      this.announce(
        fill(this.strings.lineUpdated, {
          title: product.title,
          weight: this.lineWeightText(variant, next),
          total: this.formatWeight(this.getTotals().mg)
        })
      );
    }

    removeLine(productId) {
      const line = this.bundle.get(productId);
      const product = this.products.get(productId);
      if (!line || !product) return;

      let focusTarget = null;
      const node = this.lineNodes.get(productId);
      if (node && node.contains(document.activeElement)) {
        const sibling = node.nextElementSibling || node.previousElementSibling;
        focusTarget = sibling ? sibling.querySelector('[data-mmb-action="remove"]') : this.els.summaryTitle;
      }

      this.selection.set(productId, line.variantId);
      this.bundle.delete(productId);
      this.commit([productId]);
      if (focusTarget) focusTarget.focus();
      this.announce(fill(this.strings.lineRemoved, { title: product.title, total: this.formatWeight(this.getTotals().mg) }));
    }

    clampQuantity(quantity, variant) {
      const bounded = Math.min(variant.max, Math.max(variant.min, quantity));
      return variant.min + Math.floor((bounded - variant.min) / variant.step) * variant.step;
    }

    /** Returns an error message when the line would be invalid, otherwise null. */
    checkLine(product, variant, quantity) {
      const s = this.strings;
      if (!variant || !variant.available) return fill(s.variantSoldOut, { title: product.title });
      if (this.weightRequired && variant.mg == null) return fill(s.unknownWeight, { title: product.title });
      if (this.limits.maxMg) {
        let others = 0;
        this.bundle.forEach((line, id) => {
          if (id === product.id) return;
          const v = this.getVariant(id, line.variantId);
          if (v && v.mg) others += v.mg * line.quantity;
        });
        if (others + (variant.mg || 0) * quantity > this.limits.maxMg) {
          return fill(s.maxWeight, {
            max: this.formatWeight(this.limits.maxMg),
            remaining: this.formatWeight(Math.max(0, this.limits.maxMg - others))
          });
        }
      }
      return null;
    }

    commit(productIds) {
      this.clearMessage();
      this.render(productIds);
    }

    /* --------------------------- Calculations ---------------------------- */

    getTotals() {
      const totals = { lines: [], count: 0, mg: 0, subtotal: 0, unknown: [], unavailable: [] };
      this.bundle.forEach((line) => {
        const product = this.products.get(line.productId);
        const variant = product && product.variantMap.get(line.variantId);
        if (!product || !variant) return;
        totals.lines.push({ product, variant, quantity: line.quantity });
        totals.subtotal += variant.price * line.quantity;
        if (variant.mg == null) totals.unknown.push(product.title);
        else totals.mg += variant.mg * line.quantity;
        if (!variant.available) totals.unavailable.push(product.title);
      });
      totals.count = totals.lines.length;
      return totals;
    }

    /** Converts a shop-currency amount from section settings to the customer's currency. */
    convertFromShopCurrency(cents) {
      const c = this.config;
      const rate = parseFloat(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate);
      if (c.currency && c.shopCurrency && c.currency !== c.shopCurrency && rate > 0) return Math.round(cents * rate);
      return cents;
    }

    weightUnits(mg) {
      return mg > 0 ? Math.ceil(mg / this.unitMg) : 0;
    }

    getPricing(totals) {
      const s = this.strings;
      const pricing = { total: totals.subtotal, subtotal: totals.subtotal, showSubtotal: false, savings: 0, note: '', cartQuantity: 1 };

      if (this.cartMode === 'bundle_product') {
        // The charged price is the bundle variant's own price, so what we show is what Shopify charges.
        const variant = this.bundleVariant;
        if (!variant) return pricing;
        if (this.strategy === 'weight') {
          const units = this.weightUnits(totals.mg);
          pricing.cartQuantity = Math.max(1, units);
          pricing.total = variant.price * units;
          pricing.note = fill(s.perUnit, { price: this.money(variant.price), unit: this.formatWeight(this.unitMg) });
        } else {
          pricing.total = variant.price;
        }
        return pricing;
      }

      if (this.strategy === 'sum') return pricing;

      // Individual lines + bundle pricing: Shopify charges item prices; a discount configured by the
      // merchant brings it down to the bundle price. A discount can only lower the price, so never
      // display more than the item subtotal.
      let bundlePrice;
      if (this.strategy === 'fixed') {
        bundlePrice = this.convertFromShopCurrency(Math.max(0, toInt(this.config.pricing.fixedPrice)));
      } else {
        const tier = this.tiers.find((t) => totals.mg >= t.minMg);
        const rate = tier ? tier.price : Math.max(0, toInt(this.config.pricing.weightPricePerUnit));
        bundlePrice = this.weightUnits(totals.mg) * this.convertFromShopCurrency(rate);
      }
      if (!totals.count) {
        pricing.total = this.strategy === 'fixed' ? bundlePrice : 0;
        return pricing;
      }
      pricing.total = Math.min(bundlePrice, totals.subtotal);
      pricing.savings = totals.subtotal - pricing.total;
      pricing.showSubtotal = pricing.savings > 0;
      pricing.note = pricing.savings > 0 ? this.config.pricing.note || '' : '';
      return pricing;
    }

    validate(totals) {
      const s = this.strings;
      const L = this.limits;
      const issues = [];
      if (this.cartMode === 'bundle_product') {
        if (!this.bundleVariant) issues.push({ code: 'config', message: s.bundleMissing });
        else if (!this.bundleVariant.available) issues.push({ code: 'config', message: s.bundleSoldOut });
      }
      if (!totals.count) {
        issues.push({ code: 'empty', message: s.empty });
        return issues;
      }
      totals.unavailable.forEach((title) => issues.push({ code: 'unavailable', message: fill(s.unavailableInMix, { title }) }));
      if (this.weightRequired) {
        totals.unknown.forEach((title) => issues.push({ code: 'weight', message: fill(s.unknownWeight, { title }) }));
      }
      if (L.minProducts && totals.count < L.minProducts) {
        issues.push({ code: 'min-products', message: fill(s.minProducts, { min: L.minProducts, remaining: L.minProducts - totals.count }) });
      }
      if (L.maxProducts && totals.count > L.maxProducts) {
        issues.push({ code: 'max-products', message: fill(s.maxProducts, { max: L.maxProducts }) });
      }
      if (L.minMg && totals.mg < L.minMg) {
        issues.push({
          code: 'min-weight',
          message: fill(s.minWeight, { remaining: this.formatWeight(L.minMg - totals.mg), min: this.formatWeight(L.minMg) })
        });
      }
      if (L.maxMg && totals.mg > L.maxMg) {
        issues.push({ code: 'max-weight', message: fill(s.overWeight, { max: this.formatWeight(L.maxMg) }) });
      }
      return issues;
    }

    /* ----------------------------- Rendering ----------------------------- */

    render(productIds) {
      const totals = this.getTotals();
      const pricing = this.getPricing(totals);
      const issues = this.validate(totals);
      this.renderLines(totals);
      this.renderSummary(totals, pricing, issues);
      const ids = productIds || Array.from(this.products.keys());
      ids.forEach((id) => this.syncCard(id));
      this.renderBar(totals, pricing);
    }

    renderLines(totals) {
      const list = this.els.lines;
      if (!list) return;

      this.lineNodes.forEach((node, id) => {
        if (!this.bundle.has(id)) {
          node.remove();
          this.lineNodes.delete(id);
        }
      });

      let index = 0;
      this.bundle.forEach((line, id) => {
        let node = this.lineNodes.get(id);
        if (!node) {
          node = this.createLineNode(id);
          if (!node) return;
          this.lineNodes.set(id, node);
        }
        this.updateLineNode(node, line, totals);
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
        index += 1;
      });

      list.hidden = this.bundle.size === 0;
      if (this.els.empty) this.els.empty.hidden = this.bundle.size > 0;

      if (this.highlightId) {
        const node = this.lineNodes.get(this.highlightId);
        this.highlightId = null;
        if (node) {
          node.classList.remove('is-new');
          void node.offsetWidth; // restart the animation
          node.classList.add('is-new');
          this.later(() => node.classList.remove('is-new'), 1300);
        }
      }
    }

    createLineNode(productId) {
      const template = this.els.lineTemplate;
      const product = this.products.get(productId);
      if (!template || !product) return null;
      const s = this.strings;
      const node = template.content.firstElementChild.cloneNode(true);
      const title = product.title;
      node.dataset.productId = productId;

      node.querySelector('[data-mmb-line-title]').textContent = title;
      const regional = node.querySelector('[data-mmb-line-regional]');
      if (regional) {
        regional.textContent = product.regionalName;
        regional.hidden = !(this.config.catalog && this.config.catalog.showRegionalName && product.regionalName);
      }

      const selectWrap = node.querySelector('[data-mmb-line-select-wrap]');
      const select = node.querySelector('[data-mmb-variant-select]');
      if (select && product.variants.length > 1) {
        product.variants.forEach((variant) => {
          // Sold-out variants stay listed but disabled (greyed out and announced as unavailable).
          const option = new Option(variant.title, variant.id);
          option.disabled = !variant.available;
          select.add(option);
        });
        const selectLabel = node.querySelector('[data-mmb-line-select-label]');
        if (selectLabel) selectLabel.textContent = fill(s.weightFor, { title });
      } else if (selectWrap) {
        selectWrap.remove();
      }

      const stepper = node.querySelector('[data-mmb-stepper]');
      if (stepper) {
        if (this.limits.maxQty <= 1) {
          stepper.remove();
        } else {
          stepper.setAttribute('aria-label', fill(s.quantityFor, { title }));
          node.querySelector('[data-mmb-action="decrease"]').setAttribute('aria-label', fill(s.decrease, { title }));
          node.querySelector('[data-mmb-action="increase"]').setAttribute('aria-label', fill(s.increase, { title }));
        }
      }
      node.querySelector('[data-mmb-action="remove"]').setAttribute('aria-label', fill(s.removeLine, { title }));
      return node;
    }

    updateLineNode(node, line, totals) {
      const product = this.products.get(line.productId);
      const variant = product && product.variantMap.get(line.variantId);
      if (!variant) return;

      const img = node.querySelector('[data-mmb-line-img]');
      const src = variant.image || product.image;
      if (img) {
        if (src && img.getAttribute('src') !== src) img.src = src;
        img.hidden = !src;
      }

      const select = node.querySelector('[data-mmb-variant-select]');
      if (select && select.value !== variant.id) select.value = variant.id;

      const staticLabel = node.querySelector('[data-mmb-line-static]');
      if (staticLabel) {
        const text = select ? '' : variant.mg != null ? this.formatWeight(variant.mg) : product.hasOnlyDefaultVariant ? '' : variant.title;
        staticLabel.textContent = text;
        staticLabel.hidden = !text;
      }

      const qty = node.querySelector('[data-mmb-line-qty]');
      if (qty) qty.textContent = String(line.quantity);
      const decrease = node.querySelector('[data-mmb-action="decrease"]');
      const increase = node.querySelector('[data-mmb-action="increase"]');
      if (decrease) decrease.setAttribute('aria-disabled', String(line.quantity - variant.step < variant.min));
      if (increase) {
        const overWeight = this.limits.maxMg && totals.mg + (variant.mg || 0) * variant.step > this.limits.maxMg;
        increase.setAttribute('aria-disabled', String(line.quantity + variant.step > variant.max || Boolean(overWeight)));
      }

      const weight = node.querySelector('[data-mmb-line-weight]');
      if (weight) weight.textContent = variant.mg != null ? this.formatWeight(variant.mg * line.quantity) : '';
      const meta = node.querySelector('[data-mmb-line-meta]');
      if (meta) {
        meta.textContent = line.quantity > 1 && variant.mg != null ? `${line.quantity} × ${this.formatWeight(variant.mg)}` : '';
        meta.hidden = !meta.textContent;
      }
      const price = node.querySelector('[data-mmb-line-price]');
      if (price) {
        price.hidden = this.cartMode !== 'individual';
        price.textContent = this.money(variant.price * line.quantity);
      }
    }

    renderSummary(totals, pricing, issues) {
      const e = this.els;
      const s = this.strings;
      if (e.count) e.count.textContent = this.plural(totals.count, s.spiceOne, s.spiceOther);
      if (e.totalWeight) e.totalWeight.textContent = this.formatWeight(totals.mg);
      this.renderProgress(totals);

      if (e.subtotalRow) e.subtotalRow.hidden = !pricing.showSubtotal;
      if (e.subtotal) e.subtotal.textContent = this.money(pricing.subtotal);
      if (e.savingsRow) e.savingsRow.hidden = !(pricing.showSubtotal && pricing.savings > 0);
      if (e.savings) e.savings.textContent = this.money(pricing.savings);
      if (e.total) e.total.textContent = this.money(pricing.total);
      if (e.pricingNote) {
        e.pricingNote.textContent = pricing.note;
        e.pricingNote.hidden = !pricing.note;
      }

      if (e.hint) {
        e.hint.textContent = issues.length ? issues[0].message : s.ready;
        e.hint.classList.toggle('is-ready', issues.length === 0);
      }
      if (e.addToCart) e.addToCart.setAttribute('aria-disabled', String(issues.length > 0 || this.submitting));
      if (e.save) e.save.setAttribute('aria-disabled', String(totals.count === 0));
      if (e.reset) e.reset.setAttribute('aria-disabled', String(totals.count === 0));
      if (!totals.count && e.resetConfirm) e.resetConfirm.hidden = true;
    }

    renderProgress(totals) {
      const e = this.els;
      const s = this.strings;
      const { minMg, maxMg } = this.limits;
      const target = maxMg || minMg;
      if (e.progress) e.progress.hidden = !target;
      if (!e.weightNote) return;
      if (!target) {
        e.weightNote.textContent = '';
        e.weightNote.hidden = true;
        return;
      }

      const percent = Math.min(100, (totals.mg / target) * 100);
      if (e.progressBar) e.progressBar.style.width = `${percent}%`;
      if (e.progress) {
        e.progress.setAttribute('aria-valuemax', String(Math.round(target / 1000)));
        e.progress.setAttribute('aria-valuenow', String(Math.round(Math.min(totals.mg, target) / 1000)));
        e.progress.setAttribute('aria-valuetext', fill(s.weightOf, { current: this.formatWeight(totals.mg), target: this.formatWeight(target) }));
        e.progress.classList.toggle('is-complete', totals.mg > 0 && totals.mg >= minMg && (!maxMg || totals.mg <= maxMg));
      }
      if (e.progressMin) {
        e.progressMin.hidden = !(minMg && maxMg);
        if (minMg && maxMg) e.progressMin.style.left = `${(minMg / maxMg) * 100}%`;
      }

      const parts = [];
      if (maxMg) parts.push(fill(s.remaining, { remaining: this.formatWeight(Math.max(0, maxMg - totals.mg)), max: this.formatWeight(maxMg) }));
      if (minMg) {
        parts.push(
          totals.mg >= minMg
            ? s.minimumReached
            : fill(s.toMinimum, { remaining: this.formatWeight(minMg - totals.mg), min: this.formatWeight(minMg) })
        );
      }
      e.weightNote.textContent = parts.join(' · ');
      e.weightNote.hidden = false;
    }

    renderBar(totals, pricing) {
      if (!this.els.bar || !this.els.barText) return;
      this.els.barText.textContent = [
        this.plural(totals.count, this.strings.spiceOne, this.strings.spiceOther),
        this.formatWeight(totals.mg),
        this.money(pricing.total)
      ].join(' · ');
      this.updateBarVisibility();
    }

    /* ---------------------------- Formatting ----------------------------- */

    money(cents) {
      return formatMoney(cents, this.moneyFormat);
    }

    formatWeight(mg) {
      const grams = (mg || 0) / 1000;
      if (grams >= 1000) return `${this.kgFormat.format(grams / 1000)} ${this.strings.kg}`;
      return `${this.gramFormat.format(grams)} ${this.strings.g}`;
    }

    lineWeightText(variant, quantity) {
      return variant.mg != null ? this.formatWeight(variant.mg * quantity) : `${variant.title} × ${quantity}`;
    }

    variantText(product, variant) {
      if (variant.mg != null) return this.formatWeight(variant.mg);
      return product.hasOnlyDefaultVariant ? '' : variant.title;
    }

    plural(count, one, other) {
      return fill(this.pluralRules.select(count) === 'one' ? one : other, { count });
    }

    formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleDateString(this.locale, { day: 'numeric', month: 'short', year: 'numeric' });
      } catch (error) {
        return date.toDateString();
      }
    }

    /* ------------------------ Messages & a11y ---------------------------- */

    showMessage(text, type = 'info', { cartLink = false } = {}) {
      const box = this.els.message;
      if (!box) {
        if (text) this.announce(text, type === 'error');
        return;
      }
      box.replaceChildren();
      box.hidden = !text;
      box.className = `mmb-message mmb-message--${type}`;
      if (!text) return;
      const span = document.createElement('span');
      span.textContent = text;
      box.append(span);
      if (cartLink) {
        const link = document.createElement('a');
        link.href = this.config.routes.cart;
        link.className = 'mmb-message__link';
        link.textContent = this.strings.viewCart;
        box.append(' ', link);
      }
      this.announce(text, type === 'error');
    }

    clearMessage() {
      if (this.els.message && !this.els.message.hidden) this.showMessage('');
    }

    announce(text, assertive = false) {
      const region = assertive ? this.els.liveAssertive : this.els.livePolite;
      if (!region || !text) return;
      region.textContent = '';
      this.later(() => {
        region.textContent = text;
      }, 60);
    }

    /* ------------------------------ Search ------------------------------- */

    onSearchInput() {
      this.clearTimer(this.searchTimer);
      this.searchTimer = this.later(() => this.applySearch(), 120);
      this.clearTimer(this.searchAnnounceTimer);
      this.searchAnnounceTimer = this.later(() => this.announceSearch(), 900);
    }

    clearSearch() {
      if (!this.els.search) return;
      this.els.search.value = '';
      this.applySearch();
      this.els.search.focus();
    }

    applySearch() {
      const s = this.strings;
      const raw = this.els.search ? this.els.search.value.trim() : '';
      const query = normalizeText(raw);
      this.query = query;
      if (this.els.searchClear) this.els.searchClear.hidden = !query;
      const matches = this.filterCards();

      // Search must cover the whole collection, not just the pages loaded so far.
      if (query && this.hasMorePages() && !this.searchingAll && !this.autoLoadFailed) {
        this.searchingAll = true;
        this.loadAllPages()
          .catch(() => {
            this.autoLoadFailed = true;
          })
          .finally(() => {
            this.searchingAll = false;
            this.applySearch();
          });
      }

      if (this.els.noResults) {
        this.els.noResults.hidden = !(query && matches === 0 && !this.searchingAll);
        this.els.noResults.textContent = fill(s.noResults, { query: raw });
      }
      if (this.els.searchStatus) {
        let status = '';
        if (query) status = this.searchingAll ? s.searching : this.plural(matches, s.resultsOne, s.resultsOther);
        this.els.searchStatus.textContent = status;
        this.els.searchStatus.hidden = !status;
      }
      this.lastSearchMatches = matches;
      this.updatePaginationUI();
    }

    /** Shows only the cards matching the current query. Returns the number of matches. */
    filterCards() {
      let matches = 0;
      this.products.forEach((product) => {
        const match = !this.query || product.searchText.includes(this.query);
        product.card.hidden = !match;
        if (match) matches += 1;
      });
      return matches;
    }

    announceSearch() {
      if (!this.query || this.searchingAll) return;
      const s = this.strings;
      this.announce(
        this.lastSearchMatches
          ? this.plural(this.lastSearchMatches, s.resultsOne, s.resultsOther)
          : fill(s.noResults, { query: this.els.search.value.trim() })
      );
    }

    /* ---------------------------- Pagination ----------------------------- */

    hasMorePages() {
      return this.pagination.page < this.pagination.totalPages;
    }

    /** Fetches the next page of this section through the Section Rendering API. */
    loadNextPage() {
      if (this.pageRequest) return this.pageRequest;
      if (!this.hasMorePages()) return Promise.resolve(0);

      const nextPage = this.pagination.page + 1;
      const url = new URL(window.location.href);
      url.searchParams.set('section_id', this.config.sectionId);
      url.searchParams.set('page', String(nextPage));
      url.hash = '';

      this.setLoadMoreBusy(true);
      this.setLoadMoreError('');
      const controller = new AbortController();
      const timer = this.later(() => controller.abort(), REQUEST_TIMEOUT_MS);

      this.pageRequest = fetch(url.toString(), {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        signal: controller.signal
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then((html) => {
          if (!this.ready) return 0;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const grid = doc.querySelector('[data-mmb-grid]');
          if (!grid) throw new Error('Unexpected section markup');
          const cards = Array.from(grid.querySelectorAll('[data-mmb-card]')).map((card) => document.importNode(card, true));
          cards.forEach((card) => this.els.grid.appendChild(card));
          const added = this.registerCards(cards);
          this.pagination.page = nextPage;
          const totalPages = toInt(grid.dataset.totalPages);
          if (totalPages) this.pagination.totalPages = totalPages;
          this.reportMissingWeights();
          if (this.query) this.filterCards();
          return added;
        })
        .finally(() => {
          this.clearTimer(timer);
          this.pageRequest = null;
          this.setLoadMoreBusy(false);
          this.updatePaginationUI();
        });
      return this.pageRequest;
    }

    async loadAllPages() {
      let requests = 0;
      while (this.ready && this.hasMorePages() && requests < MAX_PAGE_REQUESTS) {
        requests += 1;
        await this.loadNextPage();
      }
    }

    async onLoadMore() {
      if (this.pageRequest) return;
      const before = this.products.size;
      try {
        const added = await this.loadNextPage();
        this.announce(fill(this.strings.loaded, { count: added }));
        const first = Array.from(this.products.values())[before];
        if (first) first.card.focus();
      } catch (error) {
        this.setLoadMoreError(this.strings.loadMoreError);
        this.announce(this.strings.loadMoreError, true);
      }
    }

    setLoadMoreBusy(busy) {
      const button = this.els.loadMore;
      if (!button) return;
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute('aria-disabled', String(busy));
      if (this.els.loadMoreLabel) this.els.loadMoreLabel.textContent = busy ? this.strings.loading : this.strings.loadMore;
    }

    setLoadMoreError(text) {
      if (!this.els.loadMoreError) return;
      this.els.loadMoreError.textContent = text;
      this.els.loadMoreError.hidden = !text;
    }

    updatePaginationUI() {
      const e = this.els;
      if (e.loadMoreWrap) {
        e.loadMoreWrap.hidden = !(this.pagination.type === 'load_more' && this.hasMorePages() && !this.query);
      }
      if (e.loadMoreCount) {
        const showCount = this.pagination.totalItems && !(this.config.catalog && this.config.catalog.hideSoldOut);
        e.loadMoreCount.textContent = showCount
          ? fill(this.strings.showing, { shown: this.products.size, total: this.pagination.totalItems })
          : '';
        e.loadMoreCount.hidden = !showCount;
      }
      if (e.gridEmpty) e.gridEmpty.hidden = this.products.size > 0 || (this.hasMorePages() && this.pagination.type !== 'none');
    }

    /** Theme editor only: lists products whose weight can't be determined. */
    reportMissingWeights() {
      if (!this.config.designMode || !this.els.notices) return;
      const missing = [];
      this.products.forEach((product) => {
        if (product.variants.some((v) => v.mg == null)) missing.push(product.title);
      });
      let item = this.els.notices.querySelector('[data-mmb-weight-notice]');
      if (!missing.length) {
        if (item) item.remove();
        this.els.notices.hidden = !this.els.notices.querySelector('li');
        return;
      }
      if (!item) {
        item = document.createElement('li');
        item.setAttribute('data-mmb-weight-notice', '');
        this.els.notices.querySelector('ul').append(item);
      }
      item.textContent =
        `No weight found for: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` and ${missing.length - 8} more` : ''}. ` +
        'Add a weight to the option value (e.g. "10 g") or set the variant weight metafield.' +
        (this.weightRequired ? ' These products cannot be added while weight limits or weight pricing are active.' : '');
      this.els.notices.hidden = false;
    }

    /* ------------------------------ Cart --------------------------------- */

    async requestJSON(url, { method = 'GET', body } = {}) {
      const s = this.strings;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      let text = '';
      try {
        response = await fetch(url, {
          method,
          body,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          signal: controller.signal
        });
        text = await response.text();
      } catch (error) {
        throw new CartRequestError(error && error.name === 'AbortError' ? s.timeout : s.network);
      } finally {
        clearTimeout(timer);
      }

      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = null;
        }
      }
      if (!response.ok) {
        let message = s.cartError;
        if (response.status === 429) message = s.tooMany;
        else if (data && typeof data.description === 'string' && data.description) message = data.description;
        else if (data && typeof data.message === 'string' && data.message) message = data.message;
        throw new CartRequestError(message, response.status);
      }
      if (!data || typeof data !== 'object') throw new CartRequestError(s.malformed, response.status);
      return data;
    }

    createBundleId() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      return `mmb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    buildCartItems(totals, pricing) {
      const cart = this.config.cart || {};
      const s = this.strings;
      const bundleId = this.createBundleId();

      if (this.cartMode === 'bundle_product') {
        // Option B — one bundle line; composition stored as line item properties.
        const description = totals.lines
          .map(({ product, variant, quantity }) => {
            const size = this.variantText(product, variant);
            return `${product.title}${size ? ` (${size})` : ''}${quantity > 1 ? ` × ${quantity}` : ''}`;
          })
          .join(', ');
        const properties = {
          [s.propBlend]: description,
          [s.propTotalWeight]: this.formatWeight(totals.mg),
          _bundle_id: bundleId,
          _bundle_components: JSON.stringify(totals.lines.map(({ variant, quantity }) => ({ variant_id: Number(variant.id), quantity })))
        };
        return [{ id: Number(this.bundleVariant.id), quantity: pricing.cartQuantity, properties }];
      }

      // Option A — every spice variant is its own cart line.
      return totals.lines.map(({ variant, quantity }) => {
        const item = { id: Number(variant.id), quantity };
        if (cart.addProperties) item.properties = { [s.propBundle]: cart.bundleName || s.propBundle, _bundle_id: bundleId };
        return item;
      });
    }

    cartSectionIds() {
      const cart = this.config.cart || {};
      if (cart.afterAdd !== 'drawer') return [];
      return String(cart.sections || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 5);
    }

    async addToCart() {
      if (this.submitting) return;
      const s = this.strings;
      const totals = this.getTotals();
      const pricing = this.getPricing(totals);
      const issues = this.validate(totals);
      if (issues.length) {
        this.showMessage(issues[0].message, 'error');
        return;
      }

      this.setSubmitting(true);
      this.showMessage('');
      const sections = this.cartSectionIds();
      const items = this.buildCartItems(totals, pricing);

      try {
        const payload = { items };
        if (sections.length) {
          payload.sections = sections.join(',');
          payload.sections_url = window.location.pathname;
        }
        let response = await this.requestJSON(this.config.routes.cartAdd, { method: 'POST', body: JSON.stringify(payload) });

        let discountWarning = false;
        if (this.shouldApplyDiscount()) {
          try {
            const updated = await this.applyDiscount(sections);
            if (updated && updated.sections) response = { ...response, sections: updated.sections };
            discountWarning = !this.isDiscountApplicable(updated);
          } catch (error) {
            discountWarning = true;
          }
        }

        this.dispatchEvent(
          new CustomEvent('masala-mix:added', {
            bubbles: true,
            detail: { items: response.items || [], request: items, pricing, totalWeightGrams: totals.mg / 1000 }
          })
        );

        if (this.config.cart.afterAdd === 'redirect') {
          window.location.assign(this.config.routes.cart);
          return;
        }

        const openedDrawer = this.updateThemeCart(response);
        if (this.config.cart.clearAfterAdd) {
          this.bundle.clear();
          this.products.forEach((product, id) => this.selection.set(id, this.defaultVariantId(product)));
          this.render();
        }
        this.showMessage(discountWarning ? s.discountFailed : s.addedToCart, discountWarning ? 'warning' : 'success', {
          cartLink: !openedDrawer
        });
      } catch (error) {
        this.showMessage(error instanceof CartRequestError ? error.message : s.cartError, 'error');
        this.refreshCartCount();
      } finally {
        this.setSubmitting(false);
      }
    }

    setSubmitting(submitting) {
      this.submitting = submitting;
      const button = this.els.addToCart;
      if (!button) return;
      button.setAttribute('aria-busy', String(submitting));
      if (this.els.addToCartLabel) this.els.addToCartLabel.textContent = submitting ? this.strings.adding : this.strings.addToCart;
      if (submitting) button.setAttribute('aria-disabled', 'true');
      else this.render([]);
    }

    shouldApplyDiscount() {
      const code = this.config.pricing && this.config.pricing.discountCode;
      return Boolean(code) && this.cartMode === 'individual' && this.strategy !== 'sum';
    }

    /** Adds the configured discount code without removing codes already in the cart. */
    async applyDiscount(sections) {
      const code = this.config.pricing.discountCode;
      const cart = await this.requestJSON(this.config.routes.cartJs);
      const existing = Array.isArray(cart.discount_codes) ? cart.discount_codes.map((d) => d && d.code).filter(Boolean) : [];
      if (existing.some((c) => c.toLowerCase() === code.toLowerCase())) return cart;
      const payload = { discount: [...existing, code].join(',') };
      if (sections.length) {
        payload.sections = sections.join(',');
        payload.sections_url = window.location.pathname;
      }
      return this.requestJSON(this.config.routes.cartUpdate, { method: 'POST', body: JSON.stringify(payload) });
    }

    isDiscountApplicable(cart) {
      if (!cart || !Array.isArray(cart.discount_codes)) return true; // can't verify; don't warn
      const code = this.config.pricing.discountCode.toLowerCase();
      const entry = cart.discount_codes.find((d) => d && String(d.code).toLowerCase() === code);
      return Boolean(entry) && entry.applicable !== false;
    }

    /** Refreshes the theme's cart UI. Returns true when a cart drawer was opened. */
    updateThemeCart(response) {
      let opened = false;
      const sections = (response && response.sections) || {};
      const drawer = document.querySelector('cart-drawer');

      // Dawn and most Dawn-based themes expose renderContents() on <cart-drawer>.
      if (drawer && typeof drawer.renderContents === 'function' && sections['cart-drawer']) {
        try {
          drawer.classList.remove('is-empty');
          drawer.renderContents(response);
          opened = true;
        } catch (error) {
          console.warn('[Masala Mix] Cart drawer could not be refreshed.', error);
        }
      }

      if (!opened) {
        Object.keys(sections).forEach((id) => {
          const html = sections[id];
          if (!html || id === 'cart-drawer') return;
          const target = document.getElementById(id) || document.getElementById(`shopify-section-${id}`);
          if (!target) return;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const source = doc.querySelector('.shopify-section') || doc.body;
          target.innerHTML = source.innerHTML;
        });
      }

      // Dawn pub/sub (constants.js / pubsub.js) — lets cart items refresh themselves.
      try {
        if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.cartUpdate) {
          publish(PUB_SUB_EVENTS.cartUpdate, { source: 'masala-mix-builder', cartData: response });
        }
      } catch (error) {
        /* theme without pub/sub */
      }

      const detail = { source: 'masala-mix-builder', response };
      document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail }));
      document.dispatchEvent(new CustomEvent('cart:updated', { detail }));
      document.dispatchEvent(new CustomEvent('cart:build', { detail }));
      this.refreshCartCount();
      return opened;
    }

    async refreshCartCount() {
      const selector = this.config.cart && this.config.cart.countSelector;
      if (!selector) return;
      let targets;
      try {
        targets = document.querySelectorAll(selector);
      } catch (error) {
        return; // invalid selector in settings
      }
      if (!targets.length) return;
      try {
        const cart = await this.requestJSON(this.config.routes.cartJs);
        if (typeof cart.item_count !== 'number') return;
        targets.forEach((el) => {
          el.textContent = String(cart.item_count);
          el.hidden = cart.item_count === 0 && el.hasAttribute('data-hide-when-empty');
        });
      } catch (error) {
        /* non-critical */
      }
    }

    /* --------------------------- Save my blend --------------------------- */

    get storageKey() {
      return `${this.config.storageKey}:${this.config.customerId || 'guest'}`;
    }

    isValidBlend(blend) {
      return Boolean(blend) && Array.isArray(blend.items) && blend.items.length > 0;
    }

    readLocalBlend() {
      try {
        const raw = window.localStorage.getItem(this.storageKey);
        const blend = raw ? JSON.parse(raw) : null;
        return this.isValidBlend(blend) ? blend : null;
      } catch (error) {
        return null;
      }
    }

    initSavedBlend() {
      if (!this.els.save) return;
      this.savedBlend = this.readLocalBlend();
      this.renderSavedRow();

      const endpoint = this.config.saving && this.config.saving.endpoint;
      if (!endpoint || !this.config.customerId) return;
      this.requestJSON(endpoint)
        .then((data) => {
          const remote = this.isValidBlend(data) ? data : data && this.isValidBlend(data.blend) ? data.blend : null;
          if (!remote || !this.ready) return;
          const localTime = this.savedBlend ? Date.parse(this.savedBlend.savedAt) || 0 : 0;
          if (!this.savedBlend || (Date.parse(remote.savedAt) || 0) >= localTime) {
            this.savedBlend = { ...remote, remote: true };
            this.renderSavedRow();
          }
        })
        .catch(() => {
          /* fall back to the browser copy */
        });
    }

    renderSavedRow() {
      const row = this.els.saved;
      if (!row) return;
      const blend = this.savedBlend;
      row.hidden = !blend;
      if (!blend) return;
      if (this.els.savedLabel) {
        this.els.savedLabel.textContent = fill(this.strings.savedBlend, {
          count: this.plural(blend.items.length, this.strings.spiceOne, this.strings.spiceOther),
          date: this.formatDate(blend.savedAt)
        });
      }
      if (this.els.forget) this.els.forget.hidden = Boolean(blend.remote);
    }

    async saveBlend() {
      const s = this.strings;
      if (!this.bundle.size) {
        this.showMessage(s.saveEmpty, 'error');
        return;
      }
      const blend = {
        version: 1,
        savedAt: new Date().toISOString(),
        items: Array.from(this.bundle.values()).map((line) => ({
          productId: line.productId,
          handle: this.products.get(line.productId).handle,
          variantId: line.variantId,
          quantity: line.quantity
        }))
      };

      let savedLocally = false;
      try {
        window.localStorage.setItem(this.storageKey, JSON.stringify(blend));
        savedLocally = true;
      } catch (error) {
        savedLocally = false;
      }

      let savedRemotely = false;
      const endpoint = this.config.saving && this.config.saving.endpoint;
      if (endpoint && this.config.customerId) {
        this.els.save.setAttribute('aria-busy', 'true');
        try {
          await this.requestJSON(endpoint, { method: 'POST', body: JSON.stringify(blend) });
          savedRemotely = true;
        } catch (error) {
          savedRemotely = false;
        } finally {
          this.els.save.removeAttribute('aria-busy');
        }
      }

      this.dispatchEvent(new CustomEvent('masala-mix:save', { bubbles: true, detail: { blend, savedLocally, savedRemotely } }));

      if (!savedLocally && !savedRemotely) {
        this.showMessage(s.saveFailed, 'error');
        return;
      }
      this.savedBlend = savedRemotely ? { ...blend, remote: true } : blend;
      this.renderSavedRow();
      this.showMessage(savedRemotely ? s.savedAccount : s.saved, 'success');
    }

    async restoreBlend() {
      const blend = this.savedBlend;
      if (!blend) return;
      const s = this.strings;
      const restore = this.els.saved && this.els.saved.querySelector('[data-mmb-action="restore"]');
      if (restore) restore.setAttribute('aria-busy', 'true');

      const missing = blend.items.some((item) => !this.products.has(String(item.productId)));
      if (missing && this.hasMorePages()) {
        try {
          await this.loadAllPages();
        } catch (error) {
          /* restore what is available */
        }
      }

      this.bundle.clear();
      let skipped = 0;
      blend.items.forEach((item) => {
        const product = this.products.get(String(item.productId));
        const variant = product && product.variantMap.get(String(item.variantId));
        if (!product || !variant || this.bundle.has(product.id)) {
          skipped += 1;
          return;
        }
        const quantity = this.clampQuantity(Math.max(1, toInt(item.quantity, 1)), variant);
        const overCount = this.limits.maxProducts && this.bundle.size >= this.limits.maxProducts;
        if (overCount || this.checkLine(product, variant, quantity)) {
          skipped += 1;
          return;
        }
        this.bundle.set(product.id, { productId: product.id, variantId: variant.id, quantity });
        this.selection.set(product.id, variant.id);
      });

      if (restore) restore.removeAttribute('aria-busy');
      this.commit();
      this.showMessage(skipped ? fill(s.restoredPartial, { count: skipped }) : s.restored, skipped ? 'warning' : 'success');
    }

    forgetBlend() {
      try {
        window.localStorage.removeItem(this.storageKey);
      } catch (error) {
        /* ignore */
      }
      this.savedBlend = null;
      this.renderSavedRow();
      this.showMessage(this.strings.forgotten, 'info');
      if (this.els.save) this.els.save.focus();
    }

    /* ------------------------------ Reset -------------------------------- */

    requestReset() {
      if (!this.bundle.size) return;
      const threshold = toInt(this.config.reset && this.config.reset.confirmThreshold);
      if (threshold > 0 && this.bundle.size >= threshold && this.els.resetConfirm) {
        if (this.els.resetConfirmText) this.els.resetConfirmText.textContent = fill(this.strings.resetConfirm, { count: this.bundle.size });
        this.els.resetConfirm.hidden = false;
        if (this.els.resetCancel) this.els.resetCancel.focus();
        return;
      }
      this.resetAll();
    }

    cancelReset() {
      if (this.els.resetConfirm) this.els.resetConfirm.hidden = true;
      if (this.els.reset) this.els.reset.focus();
    }

    resetAll() {
      const focusInSummary = this.els.summary && this.els.summary.contains(document.activeElement);
      this.bundle.clear();
      this.products.forEach((product, id) => this.selection.set(id, this.defaultVariantId(product)));
      if (this.els.resetConfirm) this.els.resetConfirm.hidden = true;
      this.commit();
      this.showMessage(this.strings.resetDone, 'info');
      if (focusInSummary && this.els.summaryTitle) this.els.summaryTitle.focus();
    }

    /* ---------------------------- Mobile bar ----------------------------- */

    initMobileBar() {
      const { bar, summary } = this.els;
      const layout = this.querySelector('[data-mmb-layout]');
      if (!bar || !summary || !layout || !('IntersectionObserver' in window)) return;
      this.visibility = { layout: false, summary: false };
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.target === layout) this.visibility.layout = entry.isIntersecting;
          if (entry.target === summary) this.visibility.summary = entry.isIntersecting;
        });
        this.updateBarVisibility();
      });
      this.observer.observe(layout);
      this.observer.observe(summary);
    }

    updateBarVisibility() {
      if (!this.els.bar || !this.visibility) return;
      const show = this.visibility.layout && !this.visibility.summary && this.bundle.size > 0;
      this.els.bar.classList.toggle('is-visible', show);
    }

    scrollToSummary() {
      const { summary, summaryTitle } = this.els;
      if (!summary) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      summary.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (summaryTitle) summaryTitle.focus({ preventScroll: true });
    }
  }

  customElements.define('masala-mix-builder', MasalaMixBuilder);
})();
