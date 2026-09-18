import { requireTwoDecimalCurrency } from "../../utils/currency";
import type { XmlProfile } from "../base-profile";
import type { XmlInvoiceData, XmlTaxBreakdown } from "../types";

// Factur-X / ZUGFeRD 2.2 — UN/CEFACT Cross Industry Invoice (CII), EN 16931
// profile. This doubles as the embedded XML part of a ZUGFeRD PDF/A-3 hybrid
// and as a standalone CII e-invoice.

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amt(n: number): string {
  return n.toFixed(2);
}

export class FacturxZugferdProfile implements XmlProfile {
  getProfileId(): string {
    return "facturx-zugferd";
  }
  getProfileName(): string {
    return "Factur-X / ZUGFeRD 2.2 (EN 16931)";
  }
  getMimeType(): string {
    return "application/xml";
  }

  generateXml(data: XmlInvoiceData): string {
    requireTwoDecimalCurrency(data.currency, "Structured e-invoice export");
    const isCredit = data.type === "credit_note";
    const typeCode = isCredit ? "381" : "380";
    const franchise = data.franchise_fr === true;
    const exemptionReason = "TVA non applicable, art. 293 B du CGI";

    const lines: string[] = [];
    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<rsm:CrossIndustryInvoice`);
    lines.push(`  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"`);
    lines.push(
      `  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"`,
    );
    lines.push(`  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"`);
    lines.push(`  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">`);

    // ExchangedDocumentContext — EN 16931 profile (works for ZUGFeRD 2.1+/Factur-X)
    lines.push(`  <rsm:ExchangedDocumentContext>`);
    lines.push(`    <ram:GuidelineSpecifiedDocumentContextParameter>`);
    lines.push(`      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>`);
    lines.push(`    </ram:GuidelineSpecifiedDocumentContextParameter>`);
    lines.push(`  </rsm:ExchangedDocumentContext>`);

    // ExchangedDocument
    lines.push(`  <rsm:ExchangedDocument>`);
    lines.push(`    <ram:ID>${esc(data.invoice_number)}</ram:ID>`);
    lines.push(`    <ram:TypeCode>${typeCode}</ram:TypeCode>`);
    lines.push(
      `    <ram:IssueDateTime><udt:DateTimeString format="102">${data.issue_date.replace(/-/g, "")}</udt:DateTimeString></ram:IssueDateTime>`,
    );
    if (data.notes) {
      lines.push(
        `    <ram:IncludedNote><ram:Content>${esc(data.notes)}</ram:Content></ram:IncludedNote>`,
      );
    }
    if (data.kleinunternehmer) {
      lines.push(
        `    <ram:IncludedNote><ram:Content>Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</ram:Content></ram:IncludedNote>`,
      );
    }
    if (data.document_category_code === "AE" || data.document_category_code === "K") {
      lines.push(
        `    <ram:IncludedNote><ram:Content>Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).</ram:Content></ram:IncludedNote>`,
      );
    }
    lines.push(`  </rsm:ExchangedDocument>`);

    // SupplyChainTradeTransaction
    lines.push(`  <rsm:SupplyChainTradeTransaction>`);

    // Line items
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      lines.push(`    <ram:IncludedSupplyChainTradeLineItem>`);
      lines.push(
        `      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
      );
      lines.push(
        `      <ram:SpecifiedTradeProduct><ram:Name>${esc(item.description)}</ram:Name></ram:SpecifiedTradeProduct>`,
      );
      lines.push(`      <ram:SpecifiedLineTradeAgreement>`);
      lines.push(
        `        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${amt(item.unit_price)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`,
      );
      lines.push(`      </ram:SpecifiedLineTradeAgreement>`);
      lines.push(
        `      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${mapUnitCode(item.unit)}">${item.quantity}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
      );
      lines.push(`      <ram:SpecifiedLineTradeSettlement>`);
      lines.push(`        <ram:ApplicableTradeTax>`);
      lines.push(`          <ram:TypeCode>VAT</ram:TypeCode>`);
      lines.push(
        `          <ram:CategoryCode>${franchise && item.tax_rate === 0 ? "E" : lineCategory(item.tax_category_code)}</ram:CategoryCode>`,
      );
      if (franchise && item.tax_rate === 0) {
        lines.push(`          <ram:ExemptionReason>${exemptionReason}</ram:ExemptionReason>`);
      }
      if (item.tax_rate > 0 || (item.tax_category_code && item.tax_category_code !== "Z")) {
        lines.push(
          `          <ram:RateApplicablePercent>${item.tax_rate}</ram:RateApplicablePercent>`,
        );
      }
      lines.push(`        </ram:ApplicableTradeTax>`);
      lines.push(`        <ram:SpecifiedTradeSettlementLineMonetarySummation>`);
      lines.push(`          <ram:LineTotalAmount>${amt(item.line_total)}</ram:LineTotalAmount>`);
      lines.push(`        </ram:SpecifiedTradeSettlementLineMonetarySummation>`);
      lines.push(`      </ram:SpecifiedLineTradeSettlement>`);
      lines.push(`    </ram:IncludedSupplyChainTradeLineItem>`);
    }

    // ApplicableHeaderTradeAgreement (Seller + Buyer)
    lines.push(`    <ram:ApplicableHeaderTradeAgreement>`);
    lines.push(`      <ram:SellerTradeParty>`);
    lines.push(`        <ram:Name>${esc(data.supplier.name)}</ram:Name>`);
    if (
      data.supplier.country ||
      data.supplier.address ||
      data.supplier.street ||
      data.supplier.city
    ) {
      lines.push(`        <ram:PostalTradeAddress>`);
      const street = data.supplier.street || data.supplier.address;
      if (street) lines.push(`          <ram:LineOne>${esc(street)}</ram:LineOne>`);
      if (data.supplier.city)
        lines.push(`          <ram:CityName>${esc(data.supplier.city)}</ram:CityName>`);
      if (data.supplier.postal_code)
        lines.push(
          `          <ram:PostcodeCode>${esc(data.supplier.postal_code)}</ram:PostcodeCode>`,
        );
      if (data.supplier.country)
        lines.push(`          <ram:CountryID>${esc(data.supplier.country)}</ram:CountryID>`);
      lines.push(`        </ram:PostalTradeAddress>`);
    }
    if (data.supplier.tax_id) {
      lines.push(
        `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(data.supplier.tax_id)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      );
    }
    if (data.supplier.tax_number) {
      lines.push(
        `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="DE-TAX">${esc(data.supplier.tax_number)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      );
    }
    if (data.supplier.peppol_endpoint_id) {
      lines.push(
        `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="SEID">${esc(data.supplier.peppol_endpoint_id)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      );
    }
    lines.push(`      </ram:SellerTradeParty>`);
    lines.push(`      <ram:BuyerTradeParty>`);
    lines.push(`        <ram:Name>${esc(data.customer.name)}</ram:Name>`);
    const buyerStreet = data.customer.address_line1;
    if (
      buyerStreet ||
      data.customer.address_line2 ||
      data.customer.city ||
      data.customer.postal_code ||
      data.customer.country
    ) {
      lines.push(`        <ram:PostalTradeAddress>`);
      if (buyerStreet) lines.push(`          <ram:LineOne>${esc(buyerStreet)}</ram:LineOne>`);
      if (data.customer.address_line2)
        lines.push(`          <ram:LineTwo>${esc(data.customer.address_line2)}</ram:LineTwo>`);
      if (data.customer.city)
        lines.push(`          <ram:CityName>${esc(data.customer.city)}</ram:CityName>`);
      if (data.customer.postal_code)
        lines.push(
          `          <ram:PostcodeCode>${esc(data.customer.postal_code)}</ram:PostcodeCode>`,
        );
      if (data.customer.state)
        lines.push(
          `          <ram:CountrySubDivisionName>${esc(data.customer.state)}</ram:CountrySubDivisionName>`,
        );
      if (data.customer.country)
        lines.push(`          <ram:CountryID>${esc(data.customer.country)}</ram:CountryID>`);
      lines.push(`        </ram:PostalTradeAddress>`);
    }
    if (data.customer.leitweg_id) {
      lines.push(`        <ram:ID schemeID="0204">${esc(data.customer.leitweg_id)}</ram:ID>`);
    } else if (data.customer.siren) {
      lines.push(`        <ram:ID schemeID="0009">${esc(data.customer.siren)}</ram:ID>`);
    } else if (data.customer.siret) {
      lines.push(`        <ram:ID schemeID="0002">${esc(data.customer.siret)}</ram:ID>`);
    } else if (data.customer.einvoice_receiver_id) {
      lines.push(
        `        <ram:ID schemeID="${esc(data.customer.einvoice_receiver_scheme || "0088")}">${esc(data.customer.einvoice_receiver_id)}</ram:ID>`,
      );
    }
    if (data.customer.tax_id) {
      lines.push(
        `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(data.customer.tax_id)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      );
    }
    if (data.customer.tax_number) {
      lines.push(
        `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="DE-TAX">${esc(data.customer.tax_number)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      );
    }
    lines.push(`      </ram:BuyerTradeParty>`);
    lines.push(`    </ram:ApplicableHeaderTradeAgreement>`);

    // Payment terms (ReceiveRe p.), empty delivery node
    lines.push(`    <ram:ApplicableHeaderTradeDelivery />`);
    lines.push(`    <ram:ApplicableHeaderTradeSettlement>`);
    lines.push(`      <ram:PaymentReference>${esc(data.invoice_number)}</ram:PaymentReference>`);
    lines.push(`      <ram:InvoiceCurrencyCode>${esc(data.currency)}</ram:InvoiceCurrencyCode>`);
    if (data.payment_terms) {
      lines.push(
        `      <ram:SpecifiedTradePaymentTerms><ram:Description>${esc(data.payment_terms)}</ram:Description></ram:SpecifiedTradePaymentTerms>`,
      );
    }

    // Tax breakdown
    for (const tax of data.tax_breakdown) {
      lines.push(`      <ram:ApplicableTradeTax>`);
      lines.push(`        <ram:CalculatedAmount>${amt(tax.tax_amount)}</ram:CalculatedAmount>`);
      lines.push(`        <ram:TypeCode>VAT</ram:TypeCode>`);
      lines.push(`        <ram:BasisAmount>${amt(tax.taxable_amount)}</ram:BasisAmount>`);
      lines.push(
        `        <ram:CategoryCode>${franchise && tax.tax_rate === 0 ? "E" : taxCategory(tax)}</ram:CategoryCode>`,
      );
      if (franchise && tax.tax_rate === 0) {
        lines.push(`        <ram:ExemptionReason>${exemptionReason}</ram:ExemptionReason>`);
      }
      if (tax.tax_rate > 0 || tax.category_code !== "Z") {
        lines.push(
          `        <ram:RateApplicablePercent>${tax.tax_rate}</ram:RateApplicablePercent>`,
        );
      }
      lines.push(`      </ram:ApplicableTradeTax>`);
    }

    // Monetary summation
    lines.push(`      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>`);
    lines.push(`        <ram:LineTotalAmount>${amt(data.subtotal)}</ram:LineTotalAmount>`);
    if (data.discount_amount > 0) {
      lines.push(
        `        <ram:AllowanceTotalAmount>${amt(data.discount_amount)}</ram:AllowanceTotalAmount>`,
      );
    }
    lines.push(
      `        <ram:TaxBasisTotalAmount>${amt(data.subtotal - data.discount_amount)}</ram:TaxBasisTotalAmount>`,
    );
    lines.push(
      `        <ram:TaxTotalAmount currencyID="${esc(data.currency)}">${amt(data.tax_total)}</ram:TaxTotalAmount>`,
    );
    lines.push(`        <ram:GrandTotalAmount>${amt(data.total)}</ram:GrandTotalAmount>`);
    lines.push(`        <ram:TotalPrepaidAmount>0.00</ram:TotalPrepaidAmount>`);
    lines.push(`        <ram:DuePayableAmount>${amt(data.total)}</ram:DuePayableAmount>`);
    lines.push(`      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>`);
    lines.push(`    </ram:ApplicableHeaderTradeSettlement>`);
    lines.push(`  </rsm:SupplyChainTradeTransaction>`);
    lines.push(`</rsm:CrossIndustryInvoice>`);

    return lines.join("\n");
  }
}

function lineCategory(code: string | undefined): string {
  const c = (code || "S").toUpperCase();
  if (["S", "AA", "Z", "E", "AE", "K", "G", "O", "L", "M"].includes(c)) return c;
  return "S";
}

function taxCategory(tax: XmlTaxBreakdown): string {
  const c = (tax.category_code || "S").toUpperCase();
  if (["S", "AA", "Z", "E", "AE", "K", "G", "O", "L", "M"].includes(c)) return c;
  return tax.tax_rate === 0 ? "Z" : "S";
}

function mapUnitCode(unit: string): string {
  const map: Record<string, string> = {
    piece: "C62",
    hour: "HUR",
    day: "DAY",
    kg: "KGM",
    meter: "MTR",
    lump_sum: "LS",
    month: "MON",
  };
  return map[unit] || "C62";
}
