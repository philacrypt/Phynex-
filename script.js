/* =========================================================
   PHYNEX — MAIN JAVASCRIPT
   CART + QUANTITY + PRODUCT POPUP + SEARCH + CATEGORIES
   + ADVERTISEMENT CAROUSEL + CHECKOUT PAGE RENDERING
   + CHECKOUT PAYMENT (M-PESA)
   ========================================================= */

(function () {
    'use strict';

    const CART_KEY = 'phynexCart';
    const CUSTOMER_TOKEN_KEY = 'phynexCustomerToken';
    const DELIVERY_FEE = 300; // must match DELIVERY_FEE in server.js

    /* =====================================================
       BASIC HELPERS
       ===================================================== */

    function parsePrice(value) {
        return parseInt(
            String(value || '').replace(/[^\d]/g, ''),
            10
        ) || 0;
    }

    function money(value) {
        return 'KSh ' + Number(value || 0).toLocaleString('en-KE');
    }

    function slugify(text) {
        return String(text || 'product')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    /* =====================================================
       LIVE MARKETPLACE PRODUCTS
       Pulls real, admin-approved seller listings from the
       backend and injects them into the storefront (Sponsored,
       New Arrivals and the main Flash Deals grid), using the
       same ".product" card markup so cart / buy-now / the
       details popup all keep working exactly as before.
       ===================================================== */

    function buildProductCard(product) {

        const card = document.createElement('div');

        card.className = 'product';
        card.dataset.productId = product.id;
        card.dataset.description = product.description || '';
        card.dataset.specifications = product.specifications || '';
        card.dataset.trackingCode = product.trackingCode || '';
        card.dataset.sellerId = product.sellerId || '';
        card.dataset.sellerName = product.sellerName || '';
        card.dataset.sellerPhone = product.sellerPhone || '';
        card.dataset.sellerWhatsapp = product.sellerWhatsapp || '';
        // Store normalized slugs (e.g. "Phones & Tablets" -> "phones-tablets")
        // so category-tile filtering works no matter how the category name
        // is capitalized or punctuated. Space-separated so filterCategory()
        // can still do a simple "does this list contain that slug" check.
        card.dataset.category = [
            slugify(product.category || ''),
            slugify(product.subcategory || '')
        ].filter(Boolean).join(' ');
        card.dataset.categoryLabel = product.category || '';

        const priceHtml = money(product.price) +
            (product.oldPrice
                ? ' <span class="old-price">' + money(product.oldPrice) + '</span>'
                : '');

        const inStock = Number(product.stock) > 0;

        card.dataset.stock = product.stock;

        card.innerHTML =
            '<div class="product-image">' +
                '<img src="' + escapeHtml(product.image || '') + '" alt="' + escapeHtml(product.name) + '" loading="lazy">' +
            '</div>' +
            '<div class="product-info">' +
                '<div class="product-name">' + escapeHtml(product.name) + '</div>' +
                '<div class="rating">' + (product.sellerName ? 'Sold by ' + escapeHtml(product.sellerName) : '') + '</div>' +
                '<div class="price">' + priceHtml + '</div>' +
                '<div class="stock-status' + (inStock ? '' : ' sold-out') + '">' +
                    (inStock ? 'In stock' : 'Sold out') +
                '</div>' +
                '<div class="product-actions">' +
                    (inStock
                        ? '<button class="cart-btn" onclick="addToCart(this)">Add to Cart</button>' +
                          '<button class="buy-btn" onclick="buyNowFromCard(this)">Buy Now</button>'
                        : '<button class="cart-btn" disabled>Sold out</button>')
                +
                '</div>' +
            '</div>';

        return card;
    }

    async function loadMarketplaceProducts() {

        const flashGrid = document.getElementById('flashDealsGrid');
        const newGrid = document.getElementById('newArrivalsGrid');
        const sponsoredGrid = document.getElementById('sponsoredGrid');
        const sponsoredSection = document.getElementById('sponsoredSection');

        // Only run this on pages that actually have the marketplace grids.
        if (!flashGrid && !newGrid && !sponsoredGrid) return;

        try {

            const response = await fetch('/api/products');
            const data = await response.json();
            const products = Array.isArray(data.products) ? data.products : [];

            if (newGrid) {
                newGrid.innerHTML = '';
                products.slice(0, 8).forEach(function (product) {
                    newGrid.appendChild(buildProductCard(product));
                });
            }

            const sponsored = products.filter(function (product) { return product.sponsored; });

            if (sponsoredGrid && sponsored.length) {
                sponsoredGrid.innerHTML = '';
                sponsored.forEach(function (product) {
                    sponsoredGrid.appendChild(buildProductCard(product));
                });
                sponsoredGrid.style.display = '';
                if (sponsoredSection) sponsoredSection.style.display = '';
            }

            if (flashGrid) {
                products.forEach(function (product) {
                    flashGrid.appendChild(buildProductCard(product));
                });
            }

            applyUrlProductAndCategoryParams();

        } catch (error) {
            console.error('PHYNEX: Could not load live marketplace products.', error);
        }
    }

    /* =====================================================
       DEEP LINKS FROM OTHER PAGES (category.html, categories.html)
       Supports index.html?category=<slug> to auto-filter to a
       category, and index.html?product=<id> to open a specific
       product's details popup, once real listings have loaded.
       ===================================================== */

    function applyUrlProductAndCategoryParams() {

        const params = new URLSearchParams(location.search);
        const categoryParam = params.get('category');
        const productParam = params.get('product');

        if (categoryParam) {
            filterCategory(categoryParam);
        }

        if (productParam) {

            const card = document.querySelector(
                '.product[data-product-id="' + CSS.escape(productParam) + '"]'
            );

            if (card) {
                openProductPopup(getProductFromCard(card));
            }
        }
    }

    function getCart() {
        try {
            const cart = JSON.parse(
                localStorage.getItem(CART_KEY)
            );

            return Array.isArray(cart) ? cart : [];
        } catch (error) {
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem(
            CART_KEY,
            JSON.stringify(cart)
        );

        updateCartCount();
        renderCheckoutPage();
    }

    /* =====================================================
       CHECKOUT GATE
       Browsing, cart and Add to Cart stay open to everyone.
       Only the moment someone tries to actually go to checkout
       (Buy Now on a card, or Order Now in the product popup)
       do we require a signed-in customer. Anonymous shoppers
       are sent to log in / sign up, then bounced straight back
       into checkout.html afterward.
       ===================================================== */

    function goToCheckout() {

        if (!localStorage.getItem(CUSTOMER_TOKEN_KEY)) {

            window.location.href =
                'customer-login.html?redirect=' +
                encodeURIComponent('checkout.html');

            return;
        }

        window.location.href = 'checkout.html';
    }

    /* =====================================================
       CART COUNT
       ===================================================== */

    function updateCartCount() {

        const cart = getCart();

        let total = 0;

        cart.forEach(function (item) {

            const quantity = Number(
                item.qty || item.quantity
            ) || 1;

            total += Math.max(1, quantity);
        });

        const cartCount =
            document.getElementById('cart-count');

        if (cartCount) {
            cartCount.textContent =
                total +
                (total === 1 ? ' item' : ' items');
        }

        const mobileCount =
            document.getElementById('mbnCartCount');

        if (mobileCount) {
            mobileCount.textContent = total;

            mobileCount.style.display =
                total > 0 ? 'flex' : 'none';
        }
    }

    window.updateCartCount = updateCartCount;

    /* =====================================================
       CHECKOUT PAGE RENDERING
       ===================================================== */

    function renderCheckoutPage() {

        const itemsBox =
            document.getElementById('checkoutItems');

        if (!itemsBox) return; // not on checkout.html

        const emptyMsg =
            document.getElementById('checkoutEmpty');

        const subtotalEl =
            document.getElementById('checkoutSubtotal');

        const deliveryEl =
            document.getElementById('checkoutDeliveryFee');

        const totalEl =
            document.getElementById('checkoutTotal');

        const cart = getCart();

        if (!cart.length) {

            itemsBox.innerHTML = '';

            if (emptyMsg) emptyMsg.hidden = false;
            if (subtotalEl) subtotalEl.textContent = money(0);
            if (deliveryEl) deliveryEl.textContent = money(0);
            if (totalEl) totalEl.textContent = money(0);

            return;
        }

        if (emptyMsg) emptyMsg.hidden = true;

        let subtotal = 0;

        itemsBox.innerHTML = cart.map(function (item, index) {

            const qty =
                Math.max(1, Number(item.qty || item.quantity) || 1);

            const price = Number(item.price) || 0;

            subtotal += price * qty;

            return (
                '<div class="checkout-item">' +
                    '<img src="' + escapeHtml(item.image || '') + '" alt="' + escapeHtml(item.name || '') + '">' +
                    '<div>' +
                        '<strong>' + escapeHtml(item.name || '') + '</strong>' +
                        '<p>' + money(price) + ' each</p>' +
                        '<div class="line-quantity">' +
                            '<button type="button" data-qty="-1" data-index="' + index + '">−</button>' +
                            '<span>' + qty + '</span>' +
                            '<button type="button" data-qty="1" data-index="' + index + '">+</button>' +
                        '</div>' +
                    '</div>' +
                    '<div>' +
                        '<strong>' + money(price * qty) + '</strong><br>' +
                        '<button type="button" data-remove="' + index + '">Remove</button>' +
                    '</div>' +
                '</div>'
            );

        }).join('');

        const deliveryFee = DELIVERY_FEE;

        if (subtotalEl) subtotalEl.textContent = money(subtotal);
        if (deliveryEl) deliveryEl.textContent = money(deliveryFee);
        if (totalEl) totalEl.textContent = money(subtotal + deliveryFee);

        itemsBox.querySelectorAll('[data-qty]').forEach(function (button) {

            button.addEventListener('click', function () {

                const index = Number(button.dataset.index);
                const currentCart = getCart();

                if (!currentCart[index]) return;

                const newQty = Math.max(
                    1,
                    (Number(currentCart[index].qty || currentCart[index].quantity) || 1) +
                        Number(button.dataset.qty)
                );

                currentCart[index].qty = newQty;
                currentCart[index].quantity = newQty;

                saveCart(currentCart);
            });
        });

        itemsBox.querySelectorAll('[data-remove]').forEach(function (button) {

            button.addEventListener('click', function () {

                const index = Number(button.dataset.remove);
                const currentCart = getCart();

                currentCart.splice(index, 1);

                saveCart(currentCart);
            });
        });
    }

    window.renderCheckoutPage = renderCheckoutPage;

    /* =====================================================
       TOAST MESSAGE
       ===================================================== */

    function showToast(message) {

        const old =
            document.getElementById('phynexToast');

        if (old) old.remove();

        const toast =
            document.createElement('div');

        toast.id = 'phynexToast';
        toast.textContent = message;

        toast.style.cssText =
            'position:fixed;' +
            'left:50%;' +
            'bottom:80px;' +
            'transform:translateX(-50%);' +
            'background:#071a49;' +
            'color:#fff;' +
            'padding:12px 20px;' +
            'border-radius:10px;' +
            'font-size:14px;' +
            'font-weight:700;' +
            'z-index:999999;' +
            'box-shadow:0 8px 25px rgba(0,0,0,.3);' +
            'max-width:90%;' +
            'text-align:center;';

        document.body.appendChild(toast);

        setTimeout(function () {
            if (toast) toast.remove();
        }, 2000);
    }

    /* =====================================================
       GET PRODUCT INFORMATION
       ===================================================== */

    function getProductFromCard(card) {

        const nameElement =
            card.querySelector('.product-name');

        const priceElement =
            card.querySelector('.price');

        const oldPriceElement =
            card.querySelector('.old-price');

        const discountElement =
            card.querySelector('.discount');

        const imageElement =
            card.querySelector('.product-image img');

        const ratingElement =
            card.querySelector('.rating');

        const name =
            nameElement
                ? nameElement.textContent.trim()
                : 'Product';

        let priceText = '';

        if (priceElement) {

            let text = '';

            priceElement.childNodes.forEach(
                function (node) {

                    if (
                        node.nodeType ===
                        Node.TEXT_NODE
                    ) {
                        text += node.textContent;
                    }

                }
            );

            priceText = text.trim();

            if (!priceText) {
                priceText =
                    priceElement.textContent.trim();
            }
        }

        const price =
            parsePrice(priceText);

        return {
            id:
                card.dataset.productId ||
                slugify(name),

            name: name,

            price: price,

            priceDisplay:
                money(price),

            oldPrice:
                oldPriceElement
                    ? oldPriceElement.textContent.trim()
                    : '',

            discount:
                discountElement
                    ? discountElement.textContent.trim()
                    : '',

            image:
                imageElement
                    ? imageElement.src
                    : '',

            rating:
                ratingElement
                    ? ratingElement.textContent.trim()
                    : '',

            description:
                card.dataset.description || '',

            specifications:
                card.dataset.specifications || '',

            trackingCode:
                card.dataset.trackingCode || '',

            sellerId:
                card.dataset.sellerId || '',

            sellerName:
                card.dataset.sellerName || '',

            sellerPhone:
                card.dataset.sellerPhone || '',

            sellerWhatsapp:
                card.dataset.sellerWhatsapp || ''
        };
    }

    /* =====================================================
       ADD PRODUCT TO CART
       ===================================================== */

    function addProductToCart(product, quantity) {

        if (!product) return;

        quantity =
            Math.max(
                1,
                Number(quantity) || 1
            );

        const cart = getCart();

        const existing =
            cart.find(function (item) {
                return item.id === product.id;
            });

        if (existing) {

            const oldQuantity =
                Number(
                    existing.qty ||
                    existing.quantity
                ) || 1;

            existing.qty =
                oldQuantity + quantity;

            existing.quantity =
                existing.qty;

        } else {

            cart.push({

                id: product.id,

                name: product.name,

                price:
                    Number(product.price) || 0,

                priceDisplay:
                    product.priceDisplay,

                oldPrice:
                    product.oldPrice || '',

                discount:
                    product.discount || '',

                image:
                    product.image || '',

                rating:
                    product.rating || '',

                description:
                    product.description || '',

                specifications:
                    product.specifications || '',

                qty: quantity,

                quantity: quantity
            });
        }

        saveCart(cart);

        showToast(
            quantity +
            ' × ' +
            product.name +
            ' added to cart'
        );
    }

    /* =====================================================
       CARD — ADD TO CART
       ===================================================== */

    window.addToCart = function (button) {

        if (!button) return;

        const card =
            button.closest('.product');

        if (!card) {
            console.error(
                'PHYNEX: Product card not found.'
            );
            return;
        }

        const product =
            getProductFromCard(card);

        addProductToCart(
            product,
            1
        );
    };

    /* =====================================================
       CARD — BUY NOW
       ===================================================== */

    window.buyNowFromCard = function (button) {

        if (!button) return;

        const card =
            button.closest('.product');

        if (!card) return;

        const product =
            getProductFromCard(card);

        const item = {
            ...product,
            qty: 1,
            quantity: 1
        };

        localStorage.setItem(
            'phynexBuyNow',
            JSON.stringify([item])
        );

        goToCheckout();
    };

    /* =====================================================
       PRODUCT POPUP
       ===================================================== */

    let currentProduct = null;

    function openProductPopup(product) {

        currentProduct = product;

        const image =
            document.getElementById(
                'modalProductImage'
            );

        const price =
            document.getElementById(
                'modalProductPrice'
            );

        const oldPrice =
            document.getElementById(
                'modalOldPrice'
            );

        const discount =
            document.getElementById(
                'modalProductDiscount'
            );

        const name =
            document.getElementById(
                'modalProductName'
            );

        const rating =
            document.getElementById(
                'modalProductRating'
            );

        const description =
            document.getElementById(
                'modalProductDescription'
            );

        const specifications =
            document.getElementById(
                'modalProductSpecifications'
            );

        const quantity =
            document.getElementById(
                'productQty'
            );

        const popup =
            document.getElementById(
                'productPopup'
            );

        if (image) {
            image.src =
                product.image || '';
        }

        if (price) {
            price.textContent =
                money(product.price);
        }

        if (oldPrice) {
            oldPrice.textContent =
                product.oldPrice || '';
        }

        if (discount) {
            discount.textContent =
                product.discount || '';
        }

        if (name) {
            name.textContent =
                product.name;
        }

        if (rating) {
            rating.textContent =
                product.rating || '';
        }

        if (description) {
            description.textContent =
                product.description ||
                'No description available.';
        }

        if (specifications) {
            specifications.textContent =
                product.specifications ||
                'No specifications listed.';
        }

        if (quantity) {
            quantity.textContent = '1';
        }

        /* ---------------------------------------------
           TRACKING CODE
           --------------------------------------------- */

        const trackingRow =
            document.getElementById('modalTrackingRow');

        const trackingCode =
            document.getElementById('modalTrackingCode');

        if (trackingRow && trackingCode) {
            if (product.trackingCode) {
                trackingCode.textContent = product.trackingCode;
                trackingRow.style.display = '';
            } else {
                trackingRow.style.display = 'none';
            }
        }

        /* ---------------------------------------------
           CONTACT SELLER (WhatsApp + phone call)
           --------------------------------------------- */

        const sellerName =
            document.getElementById('modalSellerName');

        const sellerLogo =
            document.getElementById('modalSellerLogo');

        const sellerWhatsapp =
            document.getElementById('modalSellerWhatsapp');

        const sellerWhatsappBottom =
            document.getElementById('modalSellerWhatsappBottom');

        const sellerCall =
            document.getElementById('modalSellerCall');

        const displayName =
            product.sellerName || 'PHYNEX';

        if (sellerName) {
            sellerName.textContent = displayName;
        }

        if (sellerLogo) {
            sellerLogo.textContent =
                displayName
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map(function (word) { return word.charAt(0).toUpperCase(); })
                    .join('') || 'PX';
        }

        const whatsappDigits =
            String(product.sellerWhatsapp || '')
                .replace(/\D/g, '');

        const normalizedWhatsapp =
            whatsappDigits.replace(/^0/, '254');

        const whatsappUrl =
            normalizedWhatsapp
                ? 'https://wa.me/' + normalizedWhatsapp +
                  '?text=' + encodeURIComponent('Hi, I\'m interested in "' + product.name + '" on PHYNEX.')
                : '';

        [sellerWhatsapp, sellerWhatsappBottom].forEach(function (link) {

            if (!link) return;

            if (whatsappUrl) {
                link.href = whatsappUrl;
                link.style.display = '';
            } else {
                link.removeAttribute('href');
                link.style.display = 'none';
            }
        });

        if (sellerCall) {
            const phoneDigits =
                String(product.sellerPhone || '')
                    .replace(/\D/g, '');

            if (phoneDigits) {
                sellerCall.href = 'tel:' + phoneDigits;
                sellerCall.style.display = '';
            } else {
                sellerCall.removeAttribute('href');
                sellerCall.style.display = 'none';
            }
        }

        if (popup) {
            popup.classList.add('show');
        }

        document.body.style.overflow =
            'hidden';
    }

    function closeProductPopup() {

        const popup =
            document.getElementById(
                'productPopup'
            );

        if (popup) {
            popup.classList.remove('show');
        }

        document.body.style.overflow = '';

        currentProduct = null;
    }

    /* =====================================================
       PRODUCT FILTERING
       ===================================================== */

    function getProducts() {

        return Array.from(
            document.querySelectorAll(
                '.products .product'
            )
        ).filter(function (card) {

            return !card.closest(
                '#newArrivalsGrid'
            );

        });
    }

    function showAllProducts() {

        getProducts().forEach(
            function (card) {
                card.style.display = '';
            }
        );
    }

    function scrollToProducts() {

        const section =
            document.getElementById(
                'productsSection'
            );

        if (section) {

            section.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    }

    function filterCategory(category) {

        let found = 0;

        const target = slugify(category);

        getProducts().forEach(
            function (card) {

                const categories =
                    (
                        card.dataset.category ||
                        ''
                    ).split(' ').filter(Boolean);

                // Exact slug match, or either slug containing the other,
                // so a broad tile key like "phones" still matches a fuller
                // category slug like "phones-tablets", and vice versa.
                const match =
                    categories.some(function (slug) {
                        return slug === target ||
                            slug.indexOf(target) !== -1 ||
                            target.indexOf(slug) !== -1;
                    });

                card.style.display =
                    match ? '' : 'none';

                if (match) found++;
            }
        );

        scrollToProducts();

        showToast(
            found +
            (
                found === 1
                    ? ' product'
                    : ' products'
            ) +
            ' in ' +
            category
        );
    }

    /* =====================================================
       SEARCH
       ===================================================== */

    function searchProducts() {

        const input =
            document.getElementById(
                'searchInput'
            );

        if (!input) return;

        const query =
            input.value
                .trim()
                .toLowerCase();

        if (!query) {

            showAllProducts();

            return;
        }

        let found = 0;

        getProducts().forEach(
            function (card) {

                const nameElement =
                    card.querySelector(
                        '.product-name'
                    );

                const name =
                    nameElement
                        ? nameElement.textContent
                            .toLowerCase()
                        : '';

                const match =
                    name.includes(query);

                card.style.display =
                    match ? '' : 'none';

                if (match) found++;
            }
        );

        scrollToProducts();

        showToast(
            found +
            (
                found === 1
                    ? ' result'
                    : ' results'
            ) +
            ' for "' +
            input.value.trim() +
            '"'
        );
    }

    /* =====================================================
       FLASH DEAL TIMER
       ===================================================== */

    function startFlashTimer() {

        const timer =
            document.getElementById(
                'flashDealsTimer'
            );

        if (!timer) return;

        let seconds =
            3 * 60 * 60;

        function pad(number) {
            return String(number)
                .padStart(2, '0');
        }

        function tick() {

            if (seconds <= 0) {
                seconds =
                    3 * 60 * 60;
            }

            const hours =
                Math.floor(
                    seconds / 3600
                );

            const minutes =
                Math.floor(
                    (seconds % 3600) / 60
                );

            const secs =
                seconds % 60;

            timer.textContent =
                'Ends in: ' +
                pad(hours) +
                ' : ' +
                pad(minutes) +
                ' : ' +
                pad(secs);

            seconds--;
        }

        tick();

        setInterval(
            tick,
            1000
        );
    }

    /* =====================================================
       ADVERTISEMENT CAROUSEL
       ===================================================== */

    function startAdCarousel() {

        const carousel =
            document.getElementById(
                'adCarousel'
            );

        const track =
            document.getElementById(
                'adCarouselTrack'
            );

        const slides =
            document.querySelectorAll(
                '#adCarouselTrack .ad-slide'
            );

        const dots =
            document.querySelectorAll(
                '#adCarouselDots span'
            );

        if (
            !carousel ||
            !track ||
            !slides.length
        ) {
            return;
        }

        let current = 0;

        let timer = null;

        const total =
            slides.length;

        function goToSlide(index) {

            if (index < 0) {
                index = total - 1;
            }

            if (index >= total) {
                index = 0;
            }

            current = index;

            track.style.transform =
                'translate3d(-' +
                (current * 100) +
                '%,0,0)';

            dots.forEach(
                function (dot, i) {

                    dot.classList.toggle(
                        'active',
                        i === current
                    );

                }
            );
        }

        function nextSlide() {

            goToSlide(
                current + 1
            );
        }

        function stop() {

            if (timer) {

                clearInterval(timer);

                timer = null;
            }
        }

        function start() {

            stop();

            timer =
                setInterval(
                    nextSlide,
                    3000
                );
        }

        /* Carousel dots */

        dots.forEach(
            function (dot, index) {

                dot.addEventListener(
                    'click',
                    function (event) {

                        event.preventDefault();
                        event.stopPropagation();

                        goToSlide(index);

                        start();
                    }
                );

            }
        );

        /* Touch swipe */

        let startX = 0;
        let endX = 0;

        carousel.addEventListener(
            'touchstart',
            function (event) {

                startX =
                    event.touches[0]
                        .clientX;

                stop();

            },
            { passive: true }
        );

        carousel.addEventListener(
            'touchmove',
            function (event) {

                endX =
                    event.touches[0]
                        .clientX;

            },
            { passive: true }
        );

        carousel.addEventListener(
            'touchend',
            function () {

                const distance =
                    startX - endX;

                if (distance > 50) {

                    goToSlide(
                        current + 1
                    );

                } else if (
                    distance < -50
                ) {

                    goToSlide(
                        current - 1
                    );
                }

                start();

            }
        );

        /* Start */

        goToSlide(0);

        start();
    }

    /* =====================================================
       CHECKOUT PAYMENT (M-PESA)
       Wires up the "Pay with M-PESA" button and the checkout
       form on checkout.html: sends the full order (customer
       info, delivery address, and item details) so the server
       can create a real order record, sends the STK Push
       request, polls for the payment result, and shows the
       order confirmation once payment succeeds.
       ===================================================== */

    function initCheckoutPayment() {

        const form =
            document.getElementById('checkoutForm');

        const payButton =
            document.getElementById('payWithMpesa');

        const messageEl =
            document.getElementById('checkoutMessage');

        const confirmation =
            document.getElementById('orderConfirmation');

        if (!form || !payButton) return; // not on checkout.html

        let polling = null;

        function setMessage(text) {
            if (messageEl) messageEl.textContent = text || '';
        }

        function getCurrentTotal() {

            const cart = getCart();

            let subtotal = 0;

            cart.forEach(function (item) {

                const qty =
                    Math.max(1, Number(item.qty || item.quantity) || 1);

                subtotal += (Number(item.price) || 0) * qty;
            });

            return subtotal + DELIVERY_FEE;
        }

        function validateRequiredFields() {

            const required =
                form.querySelectorAll('[required]');

            for (const field of required) {

                if (!field.value.trim()) {

                    field.focus();

                    setMessage(
                        'Please fill in all required fields before paying.'
                    );

                    return false;
                }
            }

            return true;
        }

        function showConfirmation(orderNumber, paymentInfo) {

            const cart = getCart();

            form.hidden = true;

            if (!confirmation) return;

            confirmation.hidden = false;

            document.getElementById('confirmationOrderNumber')
                .textContent = orderNumber;

            document.getElementById('confirmationCustomer')
                .textContent =
                    document.getElementById('customerName').value.trim() +
                    ' (' +
                    document.getElementById('customerPhone').value.trim() +
                    ')';

            document.getElementById('confirmationDelivery')
                .textContent =
                    document.getElementById('deliveryAddress').value.trim() +
                    ', ' +
                    document.getElementById('deliveryLocation').value.trim() +
                    ', ' +
                    document.getElementById('deliveryCounty').value.trim();

            document.getElementById('confirmationItems').innerHTML =
                cart.map(function (item) {

                    const qty =
                        Math.max(1, Number(item.qty || item.quantity) || 1);

                    return (
                        '<p>' +
                        escapeHtml(item.name) +
                        ' × ' +
                        qty +
                        ' — ' +
                        money((Number(item.price) || 0) * qty) +
                        '</p>'
                    );

                }).join('');

            document.getElementById('confirmationTotal')
                .textContent =
                    money(paymentInfo.amount || getCurrentTotal());

            localStorage.removeItem(CART_KEY);

            updateCartCount();
        }

        function pollPaymentStatus(checkoutRequestId, orderNumber) {

            let attempts = 0;

            polling = setInterval(async function () {

                attempts++;

                try {

                    const response =
                        await fetch(
                            '/api/mpesa/status/' +
                            encodeURIComponent(checkoutRequestId)
                        );

                    const data = await response.json();

                    if (data.status === 'paid') {

                        clearInterval(polling);
                        polling = null;

                        showConfirmation(orderNumber, data);

                    } else if (data.status === 'failed') {

                        clearInterval(polling);
                        polling = null;

                        setMessage(
                            data.message ||
                            'Payment was not completed. Please try again.'
                        );

                        payButton.disabled = false;
                        payButton.textContent = 'Pay with M-PESA';
                    }

                } catch (error) {
                    // keep polling through transient network errors
                }

                if (attempts >= 40) {

                    clearInterval(polling);
                    polling = null;

                    setMessage(
                        'Still waiting for confirmation. Check your phone, or try again.'
                    );

                    payButton.disabled = false;
                    payButton.textContent = 'Pay with M-PESA';
                }

            }, 3000);
        }

        payButton.addEventListener('click', async function () {

            if (!validateRequiredFields()) return;

            const mpesaPhoneField =
                document.getElementById('mpesaPhone');

            if (!mpesaPhoneField.value.trim()) {

                setMessage('Enter the M-PESA number to pay with.');

                mpesaPhoneField.focus();

                return;
            }

            const cart = getCart();

            if (!cart.length) {
                setMessage('Your cart is empty.');
                return;
            }

            payButton.disabled = true;
            payButton.textContent = 'Sending request...';

            setMessage('Sending the M-PESA payment request...');

            const customerToken =
                localStorage.getItem(CUSTOMER_TOKEN_KEY);

            const headers = {
                'Content-Type': 'application/json'
            };

            if (customerToken) {
                headers['Authorization'] = 'Bearer ' + customerToken;
            }

            try {

                const response =
                    await fetch('/api/mpesa/stkpush', {

                        method: 'POST',

                        headers: headers,

                        body: JSON.stringify({

                            mpesaPhone:
                                mpesaPhoneField.value.trim(),

                            total:
                                getCurrentTotal(),

                            customer: {
                                name: document.getElementById('customerName').value.trim(),
                                email: document.getElementById('customerEmail').value.trim(),
                                phone: document.getElementById('customerPhone').value.trim()
                            },

                            delivery: {
                                county: document.getElementById('deliveryCounty').value.trim(),
                                location: document.getElementById('deliveryLocation').value.trim(),
                                address: document.getElementById('deliveryAddress').value.trim(),
                                instructions: document.getElementById('deliveryInstructions').value.trim()
                            },

                            items:
                                cart.map(function (item) {

                                    return {

                                        id: item.id,

                                        name: item.name,

                                        image: item.image,

                                        price:
                                            Number(item.price) || 0,

                                        quantity:
                                            Math.max(
                                                1,
                                                Number(item.qty || item.quantity) || 1
                                            )
                                    };

                                })
                        })
                    });

                const data = await response.json();

                if (!response.ok) {

                    setMessage(
                        data.message ||
                        'Could not send the M-PESA request.'
                    );

                    payButton.disabled = false;
                    payButton.textContent = 'Pay with M-PESA';

                    return;
                }

                setMessage(
                    data.customerMessage ||
                    'Check your phone and enter your M-PESA PIN.'
                );

                payButton.textContent = 'Waiting for payment...';

                pollPaymentStatus(
                    data.checkoutRequestId,
                    data.orderNumber
                );

            } catch (error) {

                setMessage('Network error. Please try again.');

                payButton.disabled = false;
                payButton.textContent = 'Pay with M-PESA';
            }
        });

        form.addEventListener('submit', function (event) {

            event.preventDefault();

            setMessage(
                'Use the "Pay with M-PESA" button to complete your payment.'
            );
        });
    }

    /* =====================================================
       PAGE LOAD
       ===================================================== */

    document.addEventListener(
        'DOMContentLoaded',
        function () {

            updateCartCount();

            loadMarketplaceProducts();

            renderCheckoutPage();

            startFlashTimer();

            startAdCarousel();

            initCheckoutPayment();

            /* ---------------------------------------------
               HERO SHOP BUTTON
               --------------------------------------------- */

            const heroShop =
                document.getElementById(
                    'heroShopButton'
                );

            if (heroShop) {

                heroShop.addEventListener(
                    'click',
                    function () {

                        showAllProducts();

                        scrollToProducts();

                    }
                );
            }

            /* ---------------------------------------------
               HERO CATEGORY LINKS
               --------------------------------------------- */

            document
                .querySelectorAll(
                    '.hero-links a[data-category]'
                )
                .forEach(
                    function (link) {

                        link.addEventListener(
                            'click',
                            function () {

                                filterCategory(
                                    link.dataset.category
                                );

                            }
                        );

                    }
                );

            /* ---------------------------------------------
               CATEGORY TILES
               --------------------------------------------- */

            document
                .querySelectorAll(
                    '.category[data-category]'
                )
                .forEach(
                    function (tile) {

                        tile.style.cursor =
                            'pointer';

                        tile.addEventListener(
                            'click',
                            function () {

                                filterCategory(
                                    tile.dataset.category
                                );

                            }
                        );

                    }
                );

            /* ---------------------------------------------
               SEARCH
               --------------------------------------------- */

            const searchButton =
                document.getElementById(
                    'searchButton'
                );

            const searchInput =
                document.getElementById(
                    'searchInput'
                );

            if (searchButton) {

                searchButton.addEventListener(
                    'click',
                    searchProducts
                );
            }

            if (searchInput) {

                searchInput.addEventListener(
                    'keydown',
                    function (event) {

                        if (
                            event.key ===
                            'Enter'
                        ) {
                            searchProducts();
                        }

                    }
                );
            }

            /* ---------------------------------------------
               PRODUCT IMAGE / NAME POPUP
               Delegated on the document so this also works for
               product cards injected later (real listings loaded
               from the marketplace API), not just the ones present
               when the page first loaded.
               --------------------------------------------- */

            document.addEventListener(
                'click',
                function (event) {

                    const trigger =
                        event.target.closest(
                            '.product-image img,' +
                            '.product-name'
                        );

                    if (!trigger) return;

                    const card =
                        trigger.closest('.product');

                    if (!card) return;

                    openProductPopup(
                        getProductFromCard(card)
                    );

                }
            );

            /* ---------------------------------------------
               CLOSE POPUP
               --------------------------------------------- */

            const closeButton =
                document.querySelector(
                    '.product-popup-close'
                );

            if (closeButton) {

                closeButton.addEventListener(
                    'click',
                    closeProductPopup
                );
            }

            document.addEventListener(
                'keydown',
                function (event) {

                    if (
                        event.key ===
                        'Escape'
                    ) {

                        closeProductPopup();

                    }

                }
            );

            /* ---------------------------------------------
               PRODUCT QUANTITY
               --------------------------------------------- */

            const quantity =
                document.getElementById(
                    'productQty'
                );

            const decrease =
                document.getElementById(
                    'decreaseQty'
                );

            const increase =
                document.getElementById(
                    'increaseQty'
                );

            if (
                decrease &&
                quantity
            ) {

                decrease.addEventListener(
                    'click',
                    function () {

                        let value =
                            Number(
                                quantity.textContent
                            ) || 1;

                        value =
                            Math.max(
                                1,
                                value - 1
                            );

                        quantity.textContent =
                            value;
                    }
                );
            }

            if (
                increase &&
                quantity
            ) {

                increase.addEventListener(
                    'click',
                    function () {

                        let value =
                            Number(
                                quantity.textContent
                            ) || 1;

                        value++;

                        quantity.textContent =
                            value;
                    }
                );
            }

            /* ---------------------------------------------
               POPUP ADD TO CART
               --------------------------------------------- */

            const modalAdd =
                document.getElementById(
                    'modalAddToCart'
                );

            if (modalAdd) {

                modalAdd.addEventListener(
                    'click',
                    function () {

                        if (
                            !currentProduct
                        ) return;

                        const qty =
                            Number(
                                quantity
                                    ? quantity.textContent
                                    : 1
                            ) || 1;

                        addProductToCart(
                            currentProduct,
                            qty
                        );

                    }
                );
            }

            /* ---------------------------------------------
               POPUP ORDER NOW
               --------------------------------------------- */

            const modalBuy =
                document.getElementById(
                    'modalBuyNow'
                );

            if (modalBuy) {

                modalBuy.addEventListener(
                    'click',
                    function () {

                        if (
                            !currentProduct
                        ) return;

                        const qty =
                            Number(
                                quantity
                                    ? quantity.textContent
                                    : 1
                            ) || 1;

                        const item = {
                            ...currentProduct,
                            qty: qty,
                            quantity: qty
                        };

                        localStorage.setItem(
                            'phynexBuyNow',
                            JSON.stringify(
                                [item]
                            )
                        );

                        goToCheckout();

                    }
                );
            }
        }
    );

    /* =====================================================
       UPDATE CART WHEN STORAGE CHANGES
       ===================================================== */

    window.addEventListener(
        'storage',
        function (event) {

            if (
                event.key === CART_KEY
            ) {
                updateCartCount();
                renderCheckoutPage();
            }

        }
    );

})();
