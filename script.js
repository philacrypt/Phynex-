/* PHYNEX SHARED STORE SCRIPT */

let selectedProduct = null;
let productQuantity = 1;

function readCart() {
    try {
        return JSON.parse(localStorage.getItem("phynexCart")) || [];
    } catch (error) {
        return [];
    }
}

function writeCart(cart) {
    localStorage.setItem("phynexCart", JSON.stringify(cart));
    updateCartCount();
}

function getProductData(card) {
    const image = card.querySelector(".product-image img");
    const name = card.querySelector(".product-name");
    const price = card.querySelector(".price");
    const oldPrice = card.querySelector(".old-price");
    const rating = card.querySelector(".rating");
    const discount = card.querySelector(".discount");
    const express = card.querySelector(".express");
    const priceText = price ? price.childNodes[0].textContent.trim() : "KSh 0";

    return {
        image: image ? image.src : "",
        name: name ? name.textContent.trim() : "Product",
        price: priceText,
        numericPrice: Number(priceText.replace(/[^\d.]/g, "")) || 0,
        oldPrice: oldPrice ? oldPrice.textContent.trim() : "",
        rating: rating ? rating.textContent.trim() : "★★★★★",
        discount: discount ? discount.textContent.trim() : "",
        express: express ? express.textContent.trim() : "PHYNEX EXPRESS",
        description: card.dataset.description || "Quality product available from PHYNEX.",
        specifications: card.dataset.specifications || "Product details available from PHYNEX.",
        category: card.dataset.category || ""
    };
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function getCartTotals() {
    const subtotal = readCart().reduce(function (sum, item) {
        return sum + Number(item.price) * Number(item.quantity);
    }, 0);
    const deliveryFee = 0;
    return { subtotal: subtotal, deliveryFee: deliveryFee, total: subtotal + deliveryFee };
}

function openProduct(product) {
    const popup = document.getElementById("productPopup");
    if (!popup) return;

    selectedProduct = product;
    productQuantity = 1;
    const image = document.getElementById("modalProductImage");
    if (image) {
        image.src = product.image;
        image.alt = product.name;
    }
    setText("modalProductName", product.name);
    setText("modalProductPrice", product.price);
    setText("modalOldPrice", product.oldPrice);
    setText("modalProductRating", product.rating);
    setText("modalProductDescription", product.description);
    setText("modalProductExpress", product.express);
    setText("modalProductSpecifications", "Specifications: " + product.specifications);
    const discount = document.getElementById("modalProductDiscount");
    if (discount) {
        discount.textContent = product.discount;
        discount.style.display = product.discount ? "inline-block" : "none";
    }
    setText("productQty", productQuantity);
    popup.classList.add("show");
    document.body.style.overflow = "hidden";
}

function closeProduct() {
    const popup = document.getElementById("productPopup");
    if (popup) popup.classList.remove("show");
    document.body.style.overflow = "";
    selectedProduct = null;
    productQuantity = 1;
}

function increaseQty() {
    productQuantity++;
    setText("productQty", productQuantity);
}

function decreaseQty() {
    productQuantity = Math.max(1, productQuantity - 1);
    setText("productQty", productQuantity);
}

function updateCartCount() {
    const total = readCart().reduce(function (sum, item) {
        return sum + (Number(item.quantity) || 0);
    }, 0);
    const count = document.getElementById("cart-count");
    if (count) count.textContent = total + (total === 1 ? " item" : " items");
}

function addProductToCart(product, quantity) {
    const cart = readCart();
    const existing = cart.find(function (item) {
        return item.name === product.name;
    });
    if (existing) {
        existing.quantity = (Number(existing.quantity) || 0) + quantity;
    } else {
        cart.push({
            name: product.name,
            price: product.numericPrice,
            oldPrice: product.oldPrice,
            image: product.image,
            quantity: quantity,
            rating: product.rating,
            discount: product.discount,
            express: product.express,
            description: product.description,
            specifications: product.specifications,
            category: product.category
        });
    }
    writeCart(cart);
}

function addToCart(button) {
    const product = button
        ? getProductData(button.closest(".product"))
        : selectedProduct;
    const quantity = button ? 1 : productQuantity;
    if (!product) return;
    addProductToCart(product, quantity);
    alert("Product added to your cart!");
    if (!button) closeProduct();
}

function buyNow() {
    if (!selectedProduct) return;
    addProductToCart(selectedProduct, productQuantity);
    window.location.href = "checkout.html";
}

function filterProducts(category) {
    const cards = document.querySelectorAll(".product");
    const normalized = category.toLowerCase();
    let visible = 0;
    cards.forEach(function (card) {
        const matches = normalized === "all" || card.dataset.category.includes(normalized);
        card.hidden = !matches;
        if (matches) visible++;
    });
    const message = document.getElementById("searchMessage");
    if (message) {
        message.textContent = visible ? "" : "No products found.";
        message.hidden = visible !== 0;
    }
    return visible;
}

function searchProducts() {
    const input = document.getElementById("searchInput");
    const query = input ? input.value.trim().toLowerCase() : "";
    const cards = document.querySelectorAll(".product");
    let visible = 0;
    cards.forEach(function (card) {
        const product = getProductData(card);
        const searchable = [product.name, product.description, product.category, product.rating].join(" ").toLowerCase();
        const matches = !query || searchable.includes(query);
        card.hidden = !matches;
        if (matches) visible++;
    });
    const message = document.getElementById("searchMessage");
    if (message) {
        message.textContent = visible ? "" : "No products found.";
        message.hidden = visible !== 0;
    }
}

function setupHero() {
    const images = Array.from(document.querySelectorAll(".hero-products img"));
    const dots = Array.from(document.querySelectorAll(".hero-dots span"));
    let slide = 0;
    function renderSlide() {
        images.forEach(function (image, index) {
            image.style.opacity = index === slide ? "1" : ".35";
        });
        dots.forEach(function (dot, index) {
            dot.classList.toggle("active", index === slide);
        });
    }
    document.querySelector(".hero-arrow.left").addEventListener("click", function () {
        slide = (slide + images.length - 1) % images.length;
        renderSlide();
    });
    document.querySelector(".hero-arrow.right").addEventListener("click", function () {
        slide = (slide + 1) % images.length;
        renderSlide();
    });
    renderSlide();
}

function setupNewsletter() {
    const form = document.getElementById("newsletterForm");
    if (!form) return;
    form.addEventListener("submit", function (event) {
        event.preventDefault();
        const email = document.getElementById("newsletterEmail");
        const message = document.getElementById("newsletterMessage");
        if (!email || !message) return;
        if (!email.checkValidity()) {
            message.textContent = "Please enter a valid email address.";
            return;
        }
        message.textContent = "Thanks. Your email is ready for PHYNEX newsletter setup.";
        email.value = "";
    });
}

function renderCheckout() {
    const list = document.getElementById("checkoutItems");
    if (!list) return;
    const cart = readCart();
    const empty = document.getElementById("checkoutEmpty");
    if (!cart.length) {
        if (empty) empty.hidden = false;
        list.innerHTML = "";
        return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = cart.map(function (item, index) {
        return `<div class="checkout-item"><img src="${item.image}" alt="${item.name}"><div><strong>${item.name}</strong><p>KSh ${Number(item.price).toLocaleString()}</p><div class="line-quantity"><button type="button" data-decrease="${index}">-</button><span>${item.quantity}</span><button type="button" data-increase="${index}">+</button></div></div><button type="button" data-remove="${index}">Remove</button></div>`;
    }).join("");
    const totals = getCartTotals();
    setText("checkoutSubtotal", "KSh " + totals.subtotal.toLocaleString());
    setText("checkoutDeliveryFee", "KSh " + totals.deliveryFee.toLocaleString());
    setText("checkoutTotal", "KSh " + totals.total.toLocaleString());
    list.querySelectorAll("[data-remove]").forEach(function (button) {
        button.addEventListener("click", function () {
            const next = readCart();
            next.splice(Number(button.dataset.remove), 1);
            writeCart(next);
            renderCheckout();
        });
    });
    list.querySelectorAll("[data-increase], [data-decrease]").forEach(function (button) {
        button.addEventListener("click", function () {
            const next = readCart();
            const index = Number(button.dataset.increase || button.dataset.decrease);
            if (button.dataset.increase) next[index].quantity++;
            if (button.dataset.decrease) next[index].quantity = Math.max(1, next[index].quantity - 1);
            writeCart(next);
            renderCheckout();
        });
    });
}

function setupCheckout() {
    renderCheckout();
    const form = document.getElementById("checkoutForm");
    if (!form) return;

    const message = document.getElementById("checkoutMessage");
    const mpesaButton = document.getElementById("payWithMpesa");
    let checkoutRequestId = null;

    function getCheckoutPayload() {
        const data = new FormData(form);
        const totals = getCartTotals();
        return {
            customer: {
                name: data.get("name"),
                phone: data.get("phone"),
                email: data.get("email")
            },
            delivery: {
                county: data.get("county"),
                town: data.get("location"),
                address: data.get("address"),
                instructions: data.get("instructions")
            },
            mpesaPhone: data.get("mpesaPhone"),
            items: readCart(),
            subtotal: totals.subtotal,
            deliveryFee: totals.deliveryFee,
            total: totals.total
        };
    }

    function showMessage(text) {
        if (message) message.textContent = text;
    }

    function showConfirmation(orderNumber, payload) {
        const confirmation = document.getElementById("orderConfirmation");
        setText("confirmationOrderNumber", orderNumber);
        setText("confirmationCustomer", payload.customer.name + " | " + payload.customer.phone);
        setText("confirmationDelivery", payload.delivery.county + ", " + payload.delivery.town + ", " + payload.delivery.address);
        setText("confirmationTotal", "KSh " + payload.total.toLocaleString());
        const confirmationItems = document.getElementById("confirmationItems");
        if (confirmationItems) {
            confirmationItems.textContent = payload.items.map(function (item) {
                return item.name + " x " + item.quantity + " - KSh " + (Number(item.price) * Number(item.quantity)).toLocaleString();
            }).join(" | ");
        }
        if (confirmation) confirmation.hidden = false;
        form.hidden = true;
        localStorage.removeItem("phynexCart");
    }

    async function pollPaymentStatus() {
        if (!checkoutRequestId) return;
        try {
            const response = await fetch("/api/mpesa/status/" + encodeURIComponent(checkoutRequestId));
            const result = await response.json();
            if (result.status === "paid") {
                showMessage("M-PESA payment confirmed.");
                showConfirmation(result.orderNumber || "PHX-" + Date.now().toString().slice(-8), getCheckoutPayload());
                return;
            }
            if (result.status === "failed" || result.status === "cancelled") {
                showMessage(result.message || "M-PESA payment was not completed. Please try again.");
                return;
            }
            showMessage("M-PESA payment request sent. Check your phone and enter your PIN.");
            window.setTimeout(pollPaymentStatus, 3000);
        } catch (error) {
            showMessage("Unable to check payment status. Please try again.");
        }
    }

    async function payWithMpesa() {
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        if (!readCart().length) {
            showMessage("Your cart is empty.");
            return;
        }
        mpesaButton.disabled = true;
        showMessage("Starting M-PESA payment request...");
        try {
            const response = await fetch("/api/mpesa/stkpush", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(getCheckoutPayload())
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || "M-PESA is not configured yet.");
            checkoutRequestId = result.checkoutRequestId;
            showMessage("M-PESA payment request sent. Check your phone and enter your PIN.");
            pollPaymentStatus();
        } catch (error) {
            showMessage(error.message || "M-PESA is not configured yet.");
        } finally {
            mpesaButton.disabled = false;
        }
    }

    if (mpesaButton) mpesaButton.addEventListener("click", payWithMpesa);
    form.addEventListener("submit", function (event) {
        event.preventDefault();
        showMessage("Choose Pay with M-PESA to start payment. Your order is not confirmed until payment succeeds.");
    });
}

document.addEventListener("DOMContentLoaded", function () {
    updateCartCount();
    setupNewsletter();
    setupCheckout();

    const popup = document.getElementById("productPopup");
    if (popup) {
        const productGrid = document.querySelector(".products");
        if (productGrid) {
            productGrid.addEventListener("click", function (event) {
                const image = event.target.closest(".product-image img");
                const card = event.target.closest(".product");

                if (image && card && productGrid.contains(card)) {
                    event.preventDefault();
                    openProduct(getProductData(card));
                    return;
                }

                if (card && !event.target.closest("button") && !event.target.closest("a")) {
                    openProduct(getProductData(card));
                }
            });
        }
        document.querySelector(".product-popup-close").addEventListener("click", closeProduct);
        document.getElementById("increaseQty").addEventListener("click", increaseQty);
        document.getElementById("decreaseQty").addEventListener("click", decreaseQty);
        document.getElementById("modalAddToCart").addEventListener("click", function () { addToCart(); });
        document.getElementById("modalBuyNow").addEventListener("click", buyNow);
        popup.addEventListener("click", function (event) {
            if (event.target === popup) closeProduct();
        });
    }

    const searchButton = document.getElementById("searchButton");
    const searchInput = document.getElementById("searchInput");
    if (searchButton) searchButton.addEventListener("click", searchProducts);
    if (searchInput) searchInput.addEventListener("input", searchProducts);
    document.querySelectorAll("[data-category]").forEach(function (item) {
        if (item.classList.contains("product")) return;
        item.addEventListener("click", function () {
            const category = item.dataset.category;
            if (category) {
                filterProducts(category);
                document.getElementById("productsSection").scrollIntoView({ behavior: "smooth" });
            }
        });
    });
    ["heroShopButton", "newArrivalsButton"].forEach(function (id) {
        const button = document.getElementById(id);
        if (button) button.addEventListener("click", function () {
            filterProducts("all");
            document.getElementById("productsSection").scrollIntoView({ behavior: "smooth" });
        });
    });
    const gamingButton = document.getElementById("gamingButton");
    if (gamingButton) gamingButton.addEventListener("click", function () {
        filterProducts("gaming");
        document.getElementById("productsSection").scrollIntoView({ behavior: "smooth" });
    });
    if (document.querySelector(".hero-products")) setupHero();
});

document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeProduct();
});
